"""Run the analytics batch.

    python scripts/run_analytics.py            # every period and every source
    python scripts/run_analytics.py --period 2026-08
    python scripts/run_analytics.py --source src_92f4bbd46e      # one site, every period
    python scripts/run_analytics.py --no-per-source              # workspace totals only
    python scripts/run_analytics.py --workspace ws_ab12cd34ef
    python scripts/run_analytics.py --organization-id org_acme   # that org's default workspace

Order matters when running several: each period needs the one before it already
clustered, or growth has nothing to compare against.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.analytics import batch  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.migrate import upgrade  # noqa: E402
from app.tenant import resolve_workspace  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("analytics")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--period", help="e.g. 2026-08. Omit to run every period in order.")
    parser.add_argument("--source", default=None,
                        help="Source id (see GET /api/sources). Omit for the whole workspace.")
    parser.add_argument("--no-per-source", action="store_true",
                        help="Skip the per-source passes; cluster the workspace as a whole only.")
    parser.add_argument("--workspace", default=None,
                        help="Workspace id (see GET /api/workspaces). Default: the organisation's default workspace")
    parser.add_argument("--organization-id", default=None,
                        help="Organisation id. Default: org_default, or the workspace's own")
    args = parser.parse_args()

    upgrade()
    db = SessionLocal()
    try:
        args.workspace = resolve_workspace(db, args.workspace, args.organization_id).id
        reports = (
            [batch.run_batch(db, args.period, args.workspace, args.source)]
            if args.period
            else batch.run_for_all_periods(
                db, args.workspace, per_source=not args.no_per_source
            )
        )
        for report in [r for r in reports if r]:
            log.info(
                "%s (%s): %d questions, %.0f%% poorly answered, %d recommendations",
                report.period, report.source_label or "all sources", report.query_count,
                report.unanswered_rate * 100, len(report.recommendations),
            )
        if not any(reports):
            log.warning("No reports produced. Is there enough conversation data?")
    finally:
        db.close()


if __name__ == "__main__":
    main()
