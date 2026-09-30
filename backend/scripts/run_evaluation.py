"""Score the assistant against the held-out set.

    python scripts/run_evaluation.py

Costs one generation call and three judge calls per question, so fifty questions
is two hundred calls. Fine on Groq's free tier; check your quota on Gemini.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import evaluation  # noqa: E402
from app.config import settings  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.migrate import upgrade  # noqa: E402
from app.tenant import resolve_workspace  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s | %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("eval")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", default=None,
                        help="Workspace id (see GET /api/workspaces). Default: the organisation's default workspace")
    parser.add_argument("--organization-id", default=None,
                        help="Organisation id. Default: org_default, or the workspace's own")
    parser.add_argument("--set", default=None, help="Question file. Default: data/eval_set_<workspace>.json, "
                        "falling back to data/eval_set.json")
    parser.add_argument("--source", default=None,
                        help="Score against one indexed source only (see GET /api/sources).")
    args = parser.parse_args()

    upgrade()
    db = SessionLocal()
    try:
        args.workspace = resolve_workspace(db, args.workspace, args.organization_id).id
        path = args.set or f"data/eval_set_{args.workspace}.json"
        if not args.set and not Path(path).exists():
            path = "data/eval_set.json"
        questions = evaluation.load_question_set(path)
        log.info("Scoring %d questions from %s in %s", len(questions), path, args.workspace)
        run = evaluation.run_evaluation(db, questions, args.workspace, args.source)
        log.info("Scored %d questions; %d dropped because the judge was unreachable",
                 run.question_count, run.skipped_count)
        for label, value, target in (
            ("faithfulness     ", run.faithfulness, settings.eval_target_faithfulness),
            ("answer relevance ", run.answer_relevance, settings.eval_target_answer_relevance),
            ("context relevance", run.context_relevance, settings.eval_target_context_relevance),
        ):
            mark = "ok " if value >= target else "LOW"
            log.info("%s %s %.3f  (target %.2f)", mark, label, value, target)
        if run.faithfulness < settings.eval_target_faithfulness:
            log.warning("Faithfulness is below the %.2f target set in NFR4.",
                        settings.eval_target_faithfulness)
        if run.skipped_count > run.question_count:
            log.warning(
                "More questions were dropped than scored. The scores are real but the "
                "sample is small: rerun when the API quota has recovered."
            )
    finally:
        db.close()


if __name__ == "__main__":
    main()
