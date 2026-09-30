"""Thin wrapper over the vector store.

Everything the rest of the system does with vectors goes through these four
functions. If Chroma ever needs to become pgvector, this is the only file that
changes.

Every chunk's metadata carries workspace_id and organization_id, and searches
filter on both inside Chroma, so another tenant's chunks are never candidates.

Note that similarity is returned as cosine similarity in [0, 1]. Chroma hands
back a distance, and getting that conversion wrong would quietly corrupt every
confidence score in the system, so it happens once, here.
"""

from __future__ import annotations

import logging
import os

from app.config import settings

log = logging.getLogger(__name__)

COLLECTION = "knowledge_chunks"
_client = None
_collection = None


def _get_collection():
    global _client, _collection
    if _collection is None:
        # Must be set before chromadb is imported; passing it in Settings alone
        # does not stop the client's own start-up event.
        os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")

        import chromadb
        from chromadb.config import Settings as ChromaSettings

        os.makedirs(settings.chroma_path, exist_ok=True)
        # Telemetry is off: it is noisy, it errors on some versions, and there is
        # no reason for a project like this to phone home.
        _client = chromadb.PersistentClient(
            path=settings.chroma_path,
            settings=ChromaSettings(anonymized_telemetry=False),
        )
        _collection = _client.get_or_create_collection(
            name=COLLECTION, metadata={"hnsw:space": "cosine"}
        )
    return _collection


def upsert(chunk_ids: list[str], vectors, metadatas: list[dict], documents: list[str]) -> None:
    if not chunk_ids:
        return
    _get_collection().upsert(
        ids=chunk_ids,
        embeddings=[v.tolist() for v in vectors],
        metadatas=metadatas,
        documents=documents,
    )


def delete_source(source_id: str) -> None:
    _get_collection().delete(where={"source_id": source_id})


def _where(
    workspace_id: str | None,
    organization_id: str | None,
    source_id: str | None = None,
) -> dict | None:
    """Chroma filter for a tenant, optionally narrowed to one source.

    $and needs two or more clauses, hence the cases. The source clause is what
    lets a single workspace hold five documentation sites and still answer from
    exactly one of them.
    """
    clauses = []
    if workspace_id:
        clauses.append({"workspace_id": {"$eq": workspace_id}})
    if organization_id:
        clauses.append({"organization_id": {"$eq": organization_id}})
    if source_id:
        clauses.append({"source_id": {"$eq": source_id}})
    if not clauses:
        return None
    return clauses[0] if len(clauses) == 1 else {"$and": clauses}


def count(
    workspace_id: str | None = None,
    organization_id: str | None = None,
    source_id: str | None = None,
) -> int:
    collection = _get_collection()
    where = _where(workspace_id, organization_id, source_id)
    if where is None:
        return collection.count()
    return len(collection.get(where=where, include=[])["ids"])


def backfill_tenancy(
    default_workspace_for_org,
    organization_for_workspace: dict[str, str],
    default_organization_id: str,
    batch: int = 500,
) -> int:
    """Tag chunks indexed before workspaces or organisations existed.

    A chunk missing workspace_id goes to its organisation's default workspace
    (the default organisation's, if it has no organisation either). A chunk
    missing organization_id takes its workspace's organisation. Returns how many
    were updated.

    Chroma cannot filter on a missing key, so this reads every metadata once. It
    is cheap at this scale and a no-op after the first run.
    """
    collection = _get_collection()
    total = collection.count()
    updated = 0
    for offset in range(0, total, batch):
        page = collection.get(include=["metadatas"], limit=batch, offset=offset)
        ids, metas = [], []
        for cid, meta in zip(page["ids"], page["metadatas"]):
            meta = dict(meta or {})
            if "workspace_id" in meta and "organization_id" in meta:
                continue
            if "workspace_id" not in meta:
                meta["workspace_id"] = default_workspace_for_org(
                    meta.get("organization_id") or default_organization_id
                )
            if "organization_id" not in meta:
                meta["organization_id"] = organization_for_workspace.get(
                    meta["workspace_id"], default_organization_id
                )
            ids.append(cid)
            metas.append(meta)
        if ids:
            collection.update(ids=ids, metadatas=metas)
            updated += len(ids)
    if updated:
        log.info("Tagged %d existing chunks with their workspace and organisation", updated)
    return updated


def search(
    vector,
    top_k: int,
    workspace_id: str | None = None,
    organization_id: str | None = None,
    source_id: str | None = None,
    fetch_multiplier: int = 1,
) -> list[dict]:
    """Return the top-k chunks with cosine similarity in [0, 1], best first.

    Filtered to one workspace of one organisation, so a profile can never answer
    from another's sources, and a tenant never from another tenant's. Narrow
    further with source_id to answer from a single documentation site.

    fetch_multiplier over-fetches so the caller can drop near-duplicate chunks
    and still be left with top_k distinct passages. Overlapping windows and two
    sites that republish the same page both produce duplicates, and five copies
    of one paragraph at five different scores is not five pieces of evidence.
    """
    collection = _get_collection()
    where = _where(workspace_id, organization_id, source_id)
    available = count(workspace_id, organization_id, source_id)
    if available == 0:
        return []
    res = collection.query(
        query_embeddings=[vector.tolist()],
        n_results=min(top_k * max(1, fetch_multiplier), available),
        where=where,
        include=["documents", "metadatas", "distances"],
    )
    hits = []
    for cid, doc, meta, dist in zip(
        res["ids"][0], res["documents"][0], res["metadatas"][0], res["distances"][0]
    ):
        # Chroma's cosine distance is 1 - cosine_similarity.
        similarity = max(0.0, min(1.0, 1.0 - float(dist)))
        hits.append({"chunk_id": cid, "text": doc, "meta": meta or {}, "similarity": similarity})
    return hits
