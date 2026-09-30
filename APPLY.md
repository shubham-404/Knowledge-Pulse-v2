# KnowledgePulse — round changes

31 changed files, relative paths preserved. Drop them over your tree.
`npx tsc -p tsconfig.app.json --noEmit` and `npm run build` both pass; the
backend was exercised against a copy of your real `knowledgepulse.db`.

One new backend dependency:

    pip install reportlab==4.2.2       # already in requirements.txt

---

## Run this once, in order

    cd backend

    # 1. Adds the new columns and recovers what source attribution it can
    #    from chunk ids that still exist. Runs automatically on server start
    #    too; this just does it now so step 2 can report properly.
    python -c "from app.migrate import upgrade; upgrade()"

    # 2. Attribute the existing 766 questions to the site that answered them.
    #    Your historical turns point at chunk ids that no longer exist, because
    #    the sites were reindexed after that traffic was logged, so the cheap
    #    recovery in step 1 only reaches about 16 of them. This re-embeds each
    #    question and re-searches the live index instead. Local model, no API
    #    cost, roughly a minute per thousand questions.
    python scripts/attribute_sources.py              # dry run, prints the split
    python scripts/attribute_sources.py --apply

    # 3. Cluster every period, for the workspace as a whole AND once per site.
    #    This is what makes Insights and Report change when you pick a site.
    python scripts/run_analytics.py

    # 4. Re-score the assistant with the fixed harness.
    python scripts/run_evaluation.py

Step 3 takes a while: it is now (periods x (1 + sites)) passes rather than
(periods). With 3 periods and 5 sites that is 18 batches. `--no-per-source`
skips the per-site passes if you only want the old behaviour back quickly.

## More months (item 1)

    python scripts/seed_conversations.py --questions 800 --periods 6
    python scripts/run_analytics.py

July was always in your database — 218 questions — it had simply never been
clustered, and the old `/api/periods` only listed periods that *had* been.
That is why it was invisible. The period dropdown now lists every period with
traffic and says "not analysed" against the ones the batch has not reached,
with a button to run it for that period alone.

---

## What changed, by file

### Backend

| File | Why |
|---|---|
| `app/models.py` | `source_id`/`source_label` on messages, topic clusters and reports; `skipped_count`/`per_question` on evaluation runs |
| `app/migrate.py` | New columns, plus a best-effort backfill of message attribution from surviving chunk ids |
| `app/config.py` | `retrieval_fetch_multiplier`, evaluation retry/pause/target settings |
| `app/vector_store.py` | `source_id` filter on search and count; over-fetch so dedupe still leaves top_k |
| `app/rag/engine.py` | `deduplicate()` and `attribution()`; both applied to chat and to `retrieve_only` so evaluation scores the context chat really gets |
| `app/analytics/batch.py` | Runs per scope; `_clear_period` only clears its own scope; growth compared within scope |
| `app/routers/insights.py` | `?source=` everywhere, `/api/scopes`, richer `/api/periods`, category filters, `/api/reports/export.pdf` |
| `app/routers/chat.py` | `/api/chat/conversations`; chat accepts `source_id` |
| `app/reporting.py` | **new** — PDF renderer |
| `app/evaluation.py` | **rewritten** — see below |
| `app/schemas.py` | `PeriodOut`, `ScopeOut`, `ConversationOut`, source fields, evaluation targets |
| `scripts/attribute_sources.py` | **new** — re-derives attribution for historical traffic |
| `scripts/run_analytics.py` | `--source`, `--no-per-source` |
| `scripts/run_evaluation.py` | `--source`, reports drops and all three targets |

### Frontend

`components/filters.tsx` is new: a `ScopeProvider` holding "which site am I
looking at", shared by Overview, Insights, Report and Ask. Deliberately shared
rather than per-page — picking a site on Insights and then opening Report
should not silently put you back on whole-workspace numbers. Remembered per
organisation and workspace, and falls back to All sources if the remembered
site has been deleted.

Everything else is wiring: source and period filters on the analytics pages,
the conversation sidebar on Ask, category filters and the PDF button on Report,
the explainer on Evaluation, and the glossary and cell highlighting on Research.

---

## Notes on the two things I had to decide

**Duplicate citations.** Retrieval now asks for `top_k x 3` and collapses hits
that are the same passage — same section, or the same first 24 significant
words — keeping the best-scoring copy. Three separate things were producing
them: overlapping chunk windows, long sections split into several chunks that
all match, and two of your five indexed sites carrying the same page (Plausible
is built with Docusaurus). The UI keeps a smaller version of the same dedupe as
a safety net, so archived turns answered before this change read correctly too,
and says how many it merged.

**Evaluation.** The fix is real but I want to be plain about what it is not.
I corrected three measurement faults — failed judge calls being scored 0.0 and
averaged in, an unanchored rubric, and a per-sentence context metric that mostly
measured chunk length. Those were genuinely suppressing your numbers and I
expect a large jump. But I have not run it against your API, so I have not seen
the new figures, and neither have you. The mock data shows 0.91/0.93/0.84 so the
page can be reviewed; **that is placeholder, not a result.** Run step 4 and quote
what comes back.

The Evaluation page now shows how many questions were dropped, and warns when
more were dropped than scored — a 91% built on twelve questions is a weaker
claim than a 91% built on fifty, and the page should say so rather than let you
cite it unknowingly.
