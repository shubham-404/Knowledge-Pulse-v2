"""Attribute already-logged conversation turns to the knowledge source that answered them.

    python scripts/attribute_sources.py                 # dry run: report only
    python scripts/attribute_sources.py --apply
    python scripts/attribute_sources.py --apply --workspace ws_ab12cd34ef

Why this exists. Turns logged from now on record their source as they are
written, and `app/migrate.py` recovers it for older turns from the chunk ids they
stored. That recovery only works while those chunks still exist, and reindexing a
site replaces every chunk id it owns. An archive built before a reindex therefore
has turns whose retrieved chunks are all gone, and no amount of reading the
database will say which site answered them.

So this re-runs retrieval. Each unattributed question is embedded again and
searched against the live index, and the owner of the best-matching chunk becomes
its source. The embedding model runs locally, so the only cost is time: roughly a
minute per thousand questions on a laptop, and nothing is sent anywhere.

The generated text of the answer is not touched. This only fills in a label that
was never recorded, which is what the Insights, Report and Overview pages filter
on when you pick a documentation site.
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import embeddings, vector_store  # noqa: E402
from app.config import settings  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.migrate import upgrade  # noqa: E402
from app.models import Conversation, Message  # noqa: E402
from app.tenant import resolve_workspace  # noqa: E402

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)-7s | %(message)s", datefmt="%H:%M:%S"
)
log = logging.getLogger("attribute")

BATCH = 128


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Write the results. Without this it only reports.")
    parser.add_argument("--workspace", default=None, help="Workspace id. Default: the organisation's default.")
    parser.add_argument("--organization-id", default=None, help="Organisation id. Default: org_default.")
    parser.add_argument("--limit", type=int, default=0, help="Stop after this many turns. 0 means all.")
    args = parser.parse_args()

    upgrade()
    db = SessionLocal()
    try:
        workspace = resolve_workspace(db, args.workspace, args.organization_id)
        query = (
            db.query(Message)
            .filter(
                Message.workspace_id == workspace.id,
                Message.role == "customer",
                Message.source_id.is_(None),
            )
            .order_by(Message.created_at)
        )
        if args.limit:
            query = query.limit(args.limit)
        pending = query.all()

        if not pending:
            log.info("Every question in %s already names a source. Nothing to do.", workspace.name)
            return

        log.info("Re-running retrieval for %d unattributed questions in %s",
                 len(pending), workspace.name)

        # Assistant turns are updated alongside their question: they share a
        # conversation and a timestamp, and they were answered from the same hit.
        assistants: dict[str, list[Message]] = {}
        for row in (
            db.query(Message)
            .filter(
                Message.workspace_id == workspace.id,
                Message.role == "assistant",
                Message.source_id.is_(None),
            )
            .all()
        ):
            assistants.setdefault(row.conversation_id, []).append(row)

        tally: Counter[str] = Counter()
        unresolved = 0

        for start in range(0, len(pending), BATCH):
            window = pending[start : start + BATCH]
            vectors = embeddings.embed([m.text for m in window])
            for message, vector in zip(window, vectors):
                hits = vector_store.search(
                    vector,
                    1,
                    workspace_id=workspace.id,
                    organization_id=workspace.organization_id,
                )
                if not hits:
                    unresolved += 1
                    continue
                meta = hits[0].get("meta") or {}
                source_id, label = meta.get("source_id"), meta.get("source_label")
                if not source_id:
                    unresolved += 1
                    continue
                tally[label or source_id] += 1
                if args.apply:
                    message.source_id, message.source_label = source_id, label
                    for reply in assistants.get(message.conversation_id, []):
                        # Only the reply to this question, matched on timestamp.
                        if reply.created_at == message.created_at:
                            reply.source_id, reply.source_label = source_id, label
            if args.apply:
                db.commit()
            log.info("  %d/%d", min(start + BATCH, len(pending)), len(pending))

        log.info("")
        log.info("Attribution (%s):", "written" if args.apply else "dry run, nothing written")
        for label, count in tally.most_common():
            log.info("  %-32s %5d questions", label[:32], count)
        if unresolved:
            log.warning("  %d could not be matched to any indexed chunk", unresolved)
        if not args.apply:
            log.info("")
            log.info("Re-run with --apply to write these, then run scripts/run_analytics.py")
    finally:
        db.close()


if __name__ == "__main__":
    main()
