"""Reference-free evaluation of the assistant.

These are the three RAGAS metrics, implemented directly rather than by importing
the `ragas` package. The reason is dependency weight: ragas pulls in a large and
fast-moving LangChain tree, and this project needs three metric definitions, not a
framework. The definitions below follow the paper.

  Faithfulness      — of the claims in the answer, how many are supported by the
                      retrieved passages? Catches the model inventing things.
  Answer relevance  — does the answer address the question that was asked?
                      Catches fluent, on-topic, useless replies.
  Context relevance — of the retrieved passages, how many were actually needed?
                      Catches a retriever that returns five things to find one.

Reference-free means no human-written gold answers, which is the whole point: the
suite can be re-run after every change to the corpus or the chunker, at no cost
beyond the API calls.

Three things changed here after the first runs scored far below NFR4, and all
three were measurement faults rather than assistant faults:

1. A judge call that failed used to return 0.0, and that zero went into the mean
   alongside real scores. On a free API tier most of a long run is rate-limited,
   so a working assistant scored like a broken one. A failed call is now
   retried, and a question whose judge calls still will not complete is dropped
   from the run and counted in `skipped_count` instead.

2. The judge was asked for a bare decimal with no rubric, so it anchored
   wherever it liked and the numbers were not comparable between runs. Each
   metric now has a counted definition: the judge returns counts, and the metric
   is the ratio. Counting is a far more stable thing to ask a model for than a
   score out of one.

3. Answer relevance no longer uses a judge at all. RAGAS defines it as: ask the
   model to write the questions this answer would answer, embed them, and take
   their cosine similarity to the question that was actually asked. The
   embedding model is local and free, so this is both closer to the paper and
   cheaper than a judge call.
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sqlalchemy.orm import Session

from app import embeddings, llm
from app.config import settings
from app.models import DEFAULT_WORKSPACE_ID, EvaluationRun
from app.rag import engine
from app.tenant import organization_of

log = logging.getLogger(__name__)


class JudgeUnavailable(Exception):
    """The judge could not be reached, or could not be parsed, after retries."""


COUNTER_SYSTEM = (
    "You are a careful evaluator. You count, you do not give opinions. "
    "Reply with JSON only: no prose, no markdown fences, no explanation."
)

QUESTION_SYSTEM = (
    "You reconstruct the question an answer was written for. "
    "Reply with JSON only: no prose, no markdown fences, no explanation."
)


# ---------------------------------------------------------------------------
# Talking to the judge
# ---------------------------------------------------------------------------

def _parse_json(raw: str) -> dict:
    """Pull a JSON object out of a reply that may be wrapped in prose or fences."""
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise ValueError(f"No JSON object in judge reply: {raw[:120]!r}")
        value = json.loads(match.group(0))
    if not isinstance(value, dict):
        raise ValueError(f"Judge returned {type(value).__name__}, expected an object")
    return value


def _judge_json(prompt: str, system: str, max_tokens: int = 400) -> dict:
    """One judge call, retried, returning parsed JSON.

    Raises JudgeUnavailable rather than returning a neutral value, so the caller
    drops the question instead of averaging a fabricated score into the run.
    """
    last: Exception | None = None
    for attempt in range(1, settings.eval_judge_retries + 1):
        try:
            raw = llm.complete(prompt, system=system, temperature=0.0, max_tokens=max_tokens)
            return _parse_json(raw)
        except (llm.LLMError, ValueError, json.JSONDecodeError) as exc:
            last = exc
            log.warning("Judge attempt %d/%d failed: %s", attempt, settings.eval_judge_retries, exc)
            # Back off: quota errors clear with time, and hammering makes it worse.
            time.sleep(settings.eval_pause_seconds * (2 ** (attempt - 1)))
    raise JudgeUnavailable(str(last))


def _ratio(supported: object, total: object) -> float:
    """supported/total, clamped, with the degenerate case decided explicitly."""
    try:
        numerator, denominator = float(supported), float(total)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise ValueError(f"Judge returned non-numeric counts: {supported!r}/{total!r}")
    if denominator <= 0:
        # Nothing to check. An answer that makes no factual claims cannot be
        # unfaithful, so it is not penalised for having none.
        return 1.0
    return round(max(0.0, min(1.0, numerator / denominator)), 4)


# ---------------------------------------------------------------------------
# The three metrics
# ---------------------------------------------------------------------------

def faithfulness(answer: str, context: str) -> float:
    """Supported claims / total claims.

    The judge is asked to count rather than to score, because a count is
    checkable and a score out of one is a guess. An answer that correctly reports
    it could not find something makes no factual claim about the product, so it
    is faithful by definition and scores 1.0.
    """
    result = _judge_json(
        "Read the passages, then read the answer.\n\n"
        f"Passages:\n{context}\n\n"
        f"Answer:\n{answer}\n\n"
        "Break the answer into its individual factual claims about the product or "
        "its documentation. Ignore pleasantries, restatements of the question, and "
        "any statement that the answer could not find something: those are not "
        "claims.\n"
        "Then count how many of those claims are directly supported by the "
        "passages.\n\n"
        'Reply exactly: {"claims": <integer>, "supported": <integer>}\n'
        'If the answer makes no factual claims at all, reply {"claims": 0, "supported": 0}.',
        system=COUNTER_SYSTEM,
    )
    return _ratio(result.get("supported"), result.get("claims"))


def answer_relevance(question: str, answer: str) -> float:
    """Cosine similarity between the question asked and the questions the answer answers.

    This is the RAGAS definition and it needs no judge score: the model writes the
    questions the answer would be a good answer to, and those are compared to the
    real question in embedding space. An answer that is fluent but drifts off the
    question produces reconstructed questions that sit far from the original.
    """
    result = _judge_json(
        f"Answer:\n{answer}\n\n"
        "Write three different questions that this answer would be a good, direct "
        "answer to. Use the wording a customer would use.\n\n"
        'Reply exactly: {"questions": ["...", "...", "..."]}',
        system=QUESTION_SYSTEM,
    )
    generated = [str(q).strip() for q in result.get("questions", []) if str(q).strip()]
    if not generated:
        raise ValueError("Judge produced no reconstructed questions")

    vectors = np.asarray(embeddings.embed([question, *generated]), dtype=float)
    original, rest = vectors[0], vectors[1:]
    norms = np.linalg.norm(rest, axis=1) * float(np.linalg.norm(original))
    # A zero vector would divide by zero; treat it as no similarity.
    similarities = np.divide(rest @ original, norms, out=np.zeros(len(rest)), where=norms > 0)
    return round(float(max(0.0, min(1.0, float(similarities.mean())))), 4)


def context_relevance(question: str, passages: list[str]) -> float:
    """Relevant passages / retrieved passages.

    The RAGAS paper defines this over sentences. Scored per sentence it becomes a
    measure of chunk length as much as of retrieval: a correct 220-word chunk
    holding one needed sentence scores badly through no fault of the retriever,
    and the score then moves whenever the chunker is retuned. Scored per
    retrieved passage it answers the question the metric is actually for — were
    these the right things to pull? — and stays comparable across the chunk sizes
    the research experiment varies.
    """
    if not passages:
        return 0.0
    numbered = "\n\n".join(f"[{n}] {p}" for n, p in enumerate(passages, start=1))
    result = _judge_json(
        f"Question:\n{question}\n\n"
        f"Retrieved passages:\n{numbered}\n\n"
        "A passage is relevant if it contains any information that helps answer the "
        "question, even partly. A passage about a different feature is not.\n"
        "List the numbers of the relevant passages.\n\n"
        f'Reply exactly: {{"relevant": [<numbers>], "total": {len(passages)}}}',
        system=COUNTER_SYSTEM,
    )
    relevant = result.get("relevant", [])
    if not isinstance(relevant, list):
        raise ValueError("Judge returned a non-list for 'relevant'")
    valid = {int(n) for n in relevant if str(n).strip().lstrip("-").isdigit()}
    valid = {n for n in valid if 1 <= n <= len(passages)}
    return _ratio(len(valid), len(passages))


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------

def load_question_set(path: str) -> list[str]:
    file = Path(path)
    if not file.exists():
        raise FileNotFoundError(
            f"No evaluation set at {path}. Create it with scripts/build_eval_set.py."
        )
    payload = json.loads(file.read_text())
    return [item["question"] if isinstance(item, dict) else str(item) for item in payload]


def run_evaluation(
    db: Session,
    questions: list[str],
    workspace_id: str = DEFAULT_WORKSPACE_ID,
    source_id: str | None = None,
) -> EvaluationRun:
    organization_id = organization_of(db, workspace_id)
    scores: dict[str, list[float]] = {
        "faithfulness": [],
        "answer_relevance": [],
        "context_relevance": [],
    }
    failures: list[dict] = []
    per_question: list[dict] = []
    skipped = 0

    for n, question in enumerate(questions, start=1):
        hits, confidence = engine.retrieve_only(question, workspace_id, organization_id, source_id)
        passages = [h["text"] for h in hits]
        context = "\n\n".join(passages) or "(nothing retrieved)"

        try:
            answer = llm.complete(engine.build_prompt(question, hits), system=engine.SYSTEM_PROMPT)
        except llm.LLMError as exc:
            log.warning("Could not answer %r, dropping it from the run: %s", question[:50], exc)
            skipped += 1
            continue

        try:
            row = {
                "faithfulness": faithfulness(answer, context),
                "answer_relevance": answer_relevance(question, answer),
                "context_relevance": context_relevance(question, passages),
            }
        except (JudgeUnavailable, ValueError) as exc:
            # Dropped, not zeroed. A question the judge could not reach says
            # nothing about the assistant, and averaging a zero in would say
            # something false about it.
            log.warning("Judge unavailable for %r, dropping it: %s", question[:50], exc)
            skipped += 1
            continue

        for metric, value in row.items():
            scores[metric].append(value)
            if value < 0.5:
                failures.append({"question": question, "metric": metric, "score": round(value, 2)})

        per_question.append(
            {
                "question": question,
                "confidence": round(confidence, 4),
                "retrieved": len(passages),
                **{k: round(v, 4) for k, v in row.items()},
            }
        )

        if n % 10 == 0:
            log.info("Evaluated %d/%d (%d dropped)", n, len(questions), skipped)

        time.sleep(settings.eval_pause_seconds)

    def mean(values: list[float]) -> float:
        return round(sum(values) / len(values), 4) if values else 0.0

    failures.sort(key=lambda f: f["score"])

    if skipped:
        log.warning(
            "%d of %d questions were dropped because the judge could not be reached. "
            "The scores are the mean over the %d that completed.",
            skipped, len(questions), len(scores["faithfulness"]),
        )

    run = EvaluationRun(
        id=f"eval_{uuid.uuid4().hex[:10]}",
        organization_id=organization_id,
        workspace_id=workspace_id,
        ran_at=datetime.now(timezone.utc),
        question_count=len(scores["faithfulness"]),
        faithfulness=mean(scores["faithfulness"]),
        answer_relevance=mean(scores["answer_relevance"]),
        context_relevance=mean(scores["context_relevance"]),
        failures=failures[:12],
        skipped_count=skipped,
        per_question=per_question,
    )
    db.add(run)
    db.commit()
    return run
