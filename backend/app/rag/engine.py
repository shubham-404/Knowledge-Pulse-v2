"""Retrieval, confidence, generation, logging.

The important sequencing decision is that confidence is computed *before* the
generator runs, from the similarity distribution of the retrieved chunks alone.
That is the whole point of F2. A language model will write a fluent, assured
paragraph whether or not it had anything to work from, so its own sense of
certainty tells you nothing about whether your corpus contained the answer.
Retrieval similarity does, and it stays a valid diagnostic months later when the
generated text is long forgotten.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app import embeddings, llm, vector_store
from app.config import settings
from app.models import DEFAULT_WORKSPACE_ID, Conversation, Message
from app.tenant import organization_of

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a support assistant for one organisation. You answer only \
from the passages given to you.

Rules:
- If the passages contain the answer, give it plainly and briefly.
- If they only partly cover the question, answer the part you can and say clearly \
which part you could not find.
- If they do not cover it at all, say so directly. Do not guess, and do not fill the \
gap from general knowledge.
- Write the way a helpful colleague would. No preamble, no restating the question."""


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def current_period(when: datetime | None = None) -> str:
    when = when or datetime.now(timezone.utc)
    return when.strftime("%Y-%m")


def compute_confidence(similarities: list[float]) -> float:
    """Blend the best match with the average of the rest.

    A single strong hit surrounded by noise is weaker evidence than several
    consistent hits, so neither the maximum nor the mean alone is right. The
    weighting is configurable; 0.6 on the top match is the default.
    """
    if not similarities:
        return 0.0
    top = max(similarities)
    mean = sum(similarities) / len(similarities)
    w = settings.confidence_top_weight
    return round(max(0.0, min(1.0, w * top + (1 - w) * mean)), 4)


def _fingerprint(text: str, words: int = 24) -> str:
    """A cheap identity for a passage: its first `words` significant words.

    Two chunks cut from the same paragraph by overlapping windows, and the same
    page republished under two sources, both collapse to the same fingerprint.
    Comparing whole texts would miss both, because the tails differ.
    """
    tokens = [t for t in "".join(c.lower() if c.isalnum() else " " for c in text).split() if t]
    return " ".join(tokens[:words])


def deduplicate(hits: list[dict], top_k: int) -> list[dict]:
    """Collapse hits that are the same passage, keeping the best-scoring copy.

    Three things make one retrieval return the same material more than once:
    overlapping chunk windows, a section long enough to be split into several
    chunks that all match, and two indexed sites that carry the same page. Each
    produced a separate citation with its own similarity number, which read as
    several independent sources agreeing when it was one source repeated.

    Hits arrive best-first, so the first copy seen is the one kept, and the
    later ones are recorded against it rather than thrown away.
    """
    kept: list[dict] = []
    by_section: dict[tuple, dict] = {}
    by_text: dict[str, dict] = {}

    for hit in hits:
        meta = hit.get("meta") or {}
        section = (
            meta.get("source_id"),
            meta.get("url") or "",
            meta.get("heading_path") or "",
        )
        fingerprint = _fingerprint(hit["text"])

        existing = by_section.get(section) or by_text.get(fingerprint)
        if existing is not None:
            existing["duplicate_count"] = existing.get("duplicate_count", 1) + 1
            continue

        hit["duplicate_count"] = 1
        by_section[section] = hit
        by_text[fingerprint] = hit
        kept.append(hit)
        if len(kept) >= top_k:
            break
    return kept


def attribution(hits: list[dict]) -> tuple[str | None, str | None]:
    """The source the answer leant on hardest: the owner of the best chunk."""
    if not hits:
        return None, None
    meta = hits[0].get("meta") or {}
    return meta.get("source_id"), meta.get("source_label")


def build_prompt(question: str, hits: list[dict]) -> str:
    passages = []
    for n, hit in enumerate(hits, start=1):
        meta = hit["meta"]
        passages.append(
            f"[{n}] Source: {meta.get('source_label', 'unknown')}\n"
            f"Section: {meta.get('heading_path', '')}\n"
            f"{hit['text']}"
        )
    joined = "\n\n".join(passages) if passages else "(no passages were found)"
    return f"Passages:\n\n{joined}\n\nQuestion: {question}"


def answer(
    db: Session,
    question: str,
    session_id: str,
    synthetic: bool = False,
    created_at: datetime | None = None,
    workspace_id: str = DEFAULT_WORKSPACE_ID,
    source_id: str | None = None,
) -> Message:
    """Answer one question and persist both turns. Returns the assistant message.

    The organisation is read from the workspace, so callers only pass the
    workspace and every row written here is stamped with the right tenant.
    """
    created_at = created_at or datetime.now(timezone.utc)
    period = current_period(created_at)
    organization_id = organization_of(db, workspace_id)

    conversation = (
        db.query(Conversation)
        .filter(Conversation.session_id == session_id, Conversation.workspace_id == workspace_id)
        .one_or_none()
    )
    if conversation is None:
        conversation = Conversation(
            id=new_id("conv"),
            organization_id=organization_id,
            workspace_id=workspace_id,
            session_id=session_id,
            started_at=created_at,
            synthetic=synthetic,
        )
        db.add(conversation)
        db.flush()

    # --- retrieve -------------------------------------------------------
    query_vector = embeddings.embed_one(question)
    hits = deduplicate(
        vector_store.search(
            query_vector,
            settings.retrieval_top_k,
            workspace_id=workspace_id,
            organization_id=organization_id,
            source_id=source_id,
            fetch_multiplier=settings.retrieval_fetch_multiplier,
        ),
        settings.retrieval_top_k,
    )
    similarities = [h["similarity"] for h in hits]
    confidence = compute_confidence(similarities)
    answered_from, answered_from_label = attribution(hits)

    # --- log the customer turn ------------------------------------------
    db.add(
        Message(
            id=new_id("msg"),
            organization_id=organization_id,
            workspace_id=workspace_id,
            conversation_id=conversation.id,
            role="customer",
            text=question,
            confidence=confidence,  # carried on the query too, so clustering can use it
            retrieved_chunk_ids=[h["chunk_id"] for h in hits],
            retrieved_scores=similarities,
            source_id=answered_from,
            source_label=answered_from_label,
            created_at=created_at,
            period=period,
        )
    )

    # --- generate --------------------------------------------------------
    if not hits:
        text = (
            "There is nothing indexed yet, so I have no sources to answer from. "
            "Add a knowledge source and try again."
        )
    else:
        try:
            text = llm.complete(build_prompt(question, hits), system=SYSTEM_PROMPT)
        except llm.LLMError as exc:
            # NFR3: degrade to returning what was retrieved rather than failing.
            log.warning("Generation unavailable, returning passages: %s", exc)
            text = (
                "The answer service is unavailable, so here is the closest material "
                "from the sources:\n\n" + "\n\n".join(h["text"][:400] for h in hits[:2])
            )

    citations = [
        {
            "chunkId": h["chunk_id"],
            "sourceLabel": h["meta"].get("source_label", "unknown"),
            "headingPath": h["meta"].get("heading_path", ""),
            "similarity": round(h["similarity"], 4),
            "excerpt": h["text"][:320],
        }
        for h in hits
    ]

    assistant = Message(
        id=new_id("msg"),
        organization_id=organization_id,
        workspace_id=workspace_id,
        conversation_id=conversation.id,
        role="assistant",
        text=text,
        confidence=confidence,
        retrieved_chunk_ids=[h["chunk_id"] for h in hits],
        retrieved_scores=similarities,
        citations=citations,
        source_id=answered_from,
        source_label=answered_from_label,
        created_at=created_at,
        period=period,
    )
    db.add(assistant)
    db.commit()
    return assistant


def retrieve_only(
    question: str,
    workspace_id: str = DEFAULT_WORKSPACE_ID,
    organization_id: str | None = None,
    source_id: str | None = None,
) -> tuple[list[dict], float]:
    """Used by the evaluation harness, which needs context without logging a turn.

    Deduplicated exactly as the chat path is, so the evaluation scores the
    context the assistant would really have been given.
    """
    hits = deduplicate(
        vector_store.search(
            embeddings.embed_one(question),
            settings.retrieval_top_k,
            workspace_id=workspace_id,
            organization_id=organization_id,
            source_id=source_id,
            fetch_multiplier=settings.retrieval_fetch_multiplier,
        ),
        settings.retrieval_top_k,
    )
    return hits, compute_confidence([h["similarity"] for h in hits])
