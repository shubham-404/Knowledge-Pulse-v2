from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.analytics import batch
from app.config import settings
from app.db import SessionLocal, get_db
from app.models import (
    Chunk,
    Workspace,
    ClusterMember,
    EvaluationRun,
    Message,
    Recommendation,
    Report,
    Source,
    TopicCluster,
)
from app.schemas import (
    CitationOut,
    EvaluationOut,
    InsightDetailOut,
    InsightOut,
    MemberQueryOut,
    OverviewOut,
    PeriodOut,
    RecommendationOut,
    ReportOut,
    ScopeOut,
    TrendPointOut,
)
from app.workspaces import current_workspace

router = APIRouter(prefix="/api", tags=["insights"])


# --------------------------------------------------------------------------
# Source scope
# --------------------------------------------------------------------------
# Every read below takes an optional `source` parameter. It names one indexed
# knowledge source, and it narrows the whole page to the traffic that source
# answered. Omitting it means the whole workspace, which is what every caller
# got before the parameter existed.
#
# This is what lets one workspace hold five documentation sites and still show
# different insights for each. The analytics batch writes one set of rows per
# scope; these queries read the set that matches.

ALL_SOURCES = "all"


def _scope(source: str | None) -> str | None:
    """Normalise the query parameter. "all", "" and None all mean no narrowing."""
    if not source or source == ALL_SOURCES:
        return None
    return source


def _scoped(column, source_id: str | None):
    """Match rows of exactly one scope, never the union of several."""
    return column.is_(None) if source_id is None else column == source_id


def _current_period(db: Session, ws: Workspace, source_id: str | None = None) -> str | None:
    return (
        db.query(func.max(TopicCluster.period))
        .filter(
            TopicCluster.workspace_id == ws.id,
            _scoped(TopicCluster.source_id, source_id),
        )
        .scalar()
    )


def _samples(db: Session, cluster_id: str, limit: int) -> list[str]:
    rows = (
        db.query(Message.text)
        .join(ClusterMember, ClusterMember.message_id == Message.id)
        .filter(ClusterMember.cluster_id == cluster_id)
        .order_by(Message.confidence.asc())
        .limit(limit)
        .all()
    )
    return [r[0] for r in rows]


def _insight_out(db: Session, c: TopicCluster) -> InsightOut:
    return InsightOut(
        id=c.id,
        rank=c.rank,
        name=c.name,
        keywords=c.keywords or [],
        queryCount=c.query_count,
        previousQueryCount=c.previous_query_count,
        growth=c.growth,
        meanConfidence=c.mean_confidence,
        severity=c.severity,
        priority=c.priority,
        trend=c.trend,
        sampleQueries=_samples(db, c.id, 3),
        sourceId=c.source_id,
        sourceLabel=c.source_label,
    )


# --------------------------------------------------------------------------
# Overview
# --------------------------------------------------------------------------

def _questions(db: Session, ws: Workspace, source_id: str | None):
    """Customer turns in this workspace, narrowed to one source when asked."""
    q = db.query(Message).filter(Message.workspace_id == ws.id, Message.role == "customer")
    return q.filter(Message.source_id == source_id) if source_id else q


@router.get("/overview", response_model=OverviewOut)
def overview(
    source: str | None = None,
    period: str | None = None,
    db: Session = Depends(get_db),
    ws: Workspace = Depends(current_workspace),
):
    source_id = _scope(source)
    base = _questions(db, ws, source_id)
    period = (
        period
        or _current_period(db, ws, source_id)
        or db.query(func.max(Message.period)).filter(Message.workspace_id == ws.id).scalar()
        or ""
    )
    clusters = (
        db.query(TopicCluster)
        .filter(
            TopicCluster.workspace_id == ws.id,
            TopicCluster.period == period,
            _scoped(TopicCluster.source_id, source_id),
        )
        .all()
    )

    questions = base.filter(Message.period == period).all()
    low = sum(1 for q in questions if (q.confidence or 0) < settings.low_confidence_threshold)
    confidences = [q.confidence for q in questions if q.confidence is not None]

    periods = [
        p[0]
        for p in _questions(db, ws, source_id)
        .with_entities(Message.period)
        .filter(Message.period != "")
        .distinct()
        .order_by(Message.period)
        .all()
    ]
    volume = []
    for p in periods[-12:]:
        rows = base.filter(Message.period == p).all()
        scores = [r.confidence for r in rows if r.confidence is not None]
        volume.append(
            TrendPointOut(
                period=p,
                queries=len(rows),
                meanConfidence=round(sum(scores) / len(scores), 4) if scores else 0.0,
            )
        )

    conversation_query = db.query(func.count(func.distinct(Message.conversation_id))).filter(
        Message.workspace_id == ws.id, Message.period == period
    )
    if source_id:
        conversation_query = conversation_query.filter(Message.source_id == source_id)
    conversations = conversation_query.scalar() or 0

    return OverviewOut(
        period=period or "No data yet",
        sourceLabel=_source_label(db, source_id),
        conversationCount=conversations,
        queryCount=len(questions),
        topicCount=len(clusters),
        unansweredRate=round(low / len(questions), 4) if questions else 0.0,
        meanConfidence=round(sum(confidences) / len(confidences), 4) if confidences else 0.0,
        emergingCount=sum(1 for c in clusters if c.trend == "emerging"),
        volumeByPeriod=volume,
    )


# --------------------------------------------------------------------------
# Insights
# --------------------------------------------------------------------------

def _source_label(db: Session, source_id: str | None) -> str | None:
    if not source_id:
        return None
    source = db.get(Source, source_id)
    return source.label if source else source_id


@router.get("/periods", response_model=list[PeriodOut])
def list_periods(
    source: str | None = None,
    db: Session = Depends(get_db),
    ws: Workspace = Depends(current_workspace),
):
    """Every period that has logged questions, newest first.

    This used to list only the periods the analytics batch had already been run
    over, which made an unanalysed month invisible rather than actionable: there
    was no way to tell "no traffic in July" from "July was never clustered".
    Each row now carries its question count and whether it has been analysed, so
    the interface can offer to run the batch for the ones that have not.
    """
    source_id = _scope(source)

    volumes = dict(
        _questions(db, ws, source_id)
        .with_entities(Message.period, func.count(Message.id))
        .filter(Message.period != "")
        .group_by(Message.period)
        .all()
    )
    topics = dict(
        db.query(TopicCluster.period, func.count(TopicCluster.id))
        .filter(
            TopicCluster.workspace_id == ws.id,
            _scoped(TopicCluster.source_id, source_id),
        )
        .group_by(TopicCluster.period)
        .all()
    )

    return [
        PeriodOut(
            period=p,
            queryCount=volumes.get(p, 0),
            analysed=topics.get(p, 0) > 0,
            topicCount=topics.get(p, 0),
        )
        for p in sorted(set(volumes) | set(topics), reverse=True)
    ]


@router.get("/scopes", response_model=list[ScopeOut])
def list_scopes(db: Session = Depends(get_db), ws: Workspace = Depends(current_workspace)):
    """The knowledge sources the archive can be filtered to, plus the whole workspace.

    Only sources that have actually answered something appear: a site indexed an
    hour ago with no traffic yet has nothing to report on, and offering it as a
    filter that yields an empty page is worse than leaving it out.
    """
    counts = dict(
        db.query(Message.source_id, func.count(Message.id))
        .filter(Message.workspace_id == ws.id, Message.role == "customer")
        .group_by(Message.source_id)
        .all()
    )
    analysed = {
        row[0]
        for row in db.query(TopicCluster.source_id)
        .filter(TopicCluster.workspace_id == ws.id)
        .distinct()
        .all()
    }

    scopes = [
        ScopeOut(
            sourceId=None,
            label="All sources",
            questionCount=sum(counts.values()),
            analysed=None in analysed,
        )
    ]
    labels = {
        s.id: s.label
        for s in db.query(Source).filter(Source.workspace_id == ws.id).all()
    }
    for source_id, count in sorted(counts.items(), key=lambda kv: -kv[1]):
        if not source_id:
            continue
        scopes.append(
            ScopeOut(
                sourceId=source_id,
                label=labels.get(source_id, "Deleted source"),
                questionCount=count,
                analysed=source_id in analysed,
            )
        )
    return scopes


@router.get("/insights", response_model=list[InsightOut])
def list_insights(
    period: str | None = None,
    source: str | None = None,
    db: Session = Depends(get_db),
    ws: Workspace = Depends(current_workspace),
):
    source_id = _scope(source)
    period = period or _current_period(db, ws, source_id)
    if not period:
        return []
    rows = (
        db.query(TopicCluster)
        .filter(
            TopicCluster.workspace_id == ws.id,
            TopicCluster.period == period,
            _scoped(TopicCluster.source_id, source_id),
        )
        .order_by(TopicCluster.rank)
        .all()
    )
    return [_insight_out(db, c) for c in rows]


@router.get("/insights/{insight_id}", response_model=InsightDetailOut)
def get_insight(insight_id: str, db: Session = Depends(get_db), ws: Workspace = Depends(current_workspace)):
    cluster = db.get(TopicCluster, insight_id)
    if cluster is None or cluster.workspace_id != ws.id or cluster.organization_id != ws.organization_id:
        raise HTTPException(404, "No insight with that id")

    # Walk the chain of previous_cluster_id links backwards to build the history.
    history: list[TrendPointOut] = []
    node: TopicCluster | None = cluster
    seen: set[str] = set()
    while node is not None and node.id not in seen:
        seen.add(node.id)
        history.append(
            TrendPointOut(
                period=node.period, queries=node.query_count, meanConfidence=node.mean_confidence
            )
        )
        node = db.get(TopicCluster, node.previous_cluster_id) if node.previous_cluster_id else None
    history.reverse()

    members = (
        db.query(Message)
        .join(ClusterMember, ClusterMember.message_id == Message.id)
        .filter(ClusterMember.cluster_id == cluster.id)
        .order_by(Message.confidence.asc())
        .limit(25)
        .all()
    )

    # The passages retrieval kept returning for the worst-scoring questions.
    weakest: list[CitationOut] = []
    seen_chunks: set[str] = set()
    for message in members[:5]:
        for chunk_id, score in zip(message.retrieved_chunk_ids or [], message.retrieved_scores or []):
            if chunk_id in seen_chunks or len(weakest) >= 3:
                continue
            chunk = db.get(Chunk, chunk_id)
            if chunk is None:
                continue
            seen_chunks.add(chunk_id)
            weakest.append(
                CitationOut(
                    chunkId=chunk.id,
                    sourceLabel=chunk.source.label if chunk.source else "unknown",
                    headingPath=chunk.heading_path,
                    similarity=round(float(score), 4),
                    excerpt=chunk.text[:320],
                )
            )

    base = _insight_out(db, cluster)
    return InsightDetailOut(
        **base.model_dump(),
        history=history,
        memberQueries=[
            MemberQueryOut(
                id=m.id, text=m.text, confidence=m.confidence or 0.0, askedAt=m.created_at
            )
            for m in members
        ],
        weakestChunks=weakest,
    )


# --------------------------------------------------------------------------
# Reports
# --------------------------------------------------------------------------

def _report_out(report: Report, categories: set[str] | None = None) -> ReportOut:
    return ReportOut(
        id=report.id,
        period=report.period,
        sourceId=report.source_id,
        sourceLabel=report.source_label,
        generatedAt=report.generated_at,
        conversationCount=report.conversation_count,
        queryCount=report.query_count,
        unansweredRate=report.unanswered_rate,
        summary=report.summary,
        recommendations=[
            RecommendationOut(
                id=r.id,
                category=r.category,
                headline=r.headline,
                body=r.body,
                insightId=r.cluster_id,
                insightName=r.cluster_name,
                supportingQueries=r.supporting_queries or [],
                volume=r.volume,
                growth=r.growth,
                expectedEffect=r.expected_effect,
                faqAnswer=r.faq_answer,
            )
            for r in report.recommendations
            if categories is None or r.category in categories
        ],
    )


CATEGORIES = {"product", "documentation", "faq", "customer_issue"}


def _categories(raw: str | None) -> set[str] | None:
    """Parse the category filter. Unknown names are rejected rather than ignored,
    so a typo returns an error instead of an empty report."""
    if not raw:
        return None
    wanted = {c.strip() for c in raw.split(",") if c.strip()}
    unknown = wanted - CATEGORIES
    if unknown:
        raise HTTPException(400, f"Unknown recommendation category: {', '.join(sorted(unknown))}")
    return wanted or None


def _reports(db: Session, ws: Workspace, period: str | None, source: str | None) -> list[Report]:
    source_id = _scope(source)
    query = db.query(Report).filter(
        Report.workspace_id == ws.id,
        _scoped(Report.source_id, source_id),
    )
    if period:
        query = query.filter(Report.period == period)
    return query.order_by(Report.period.desc()).all()


@router.get("/reports/latest", response_model=ReportOut)
def latest_report(
    source: str | None = None,
    period: str | None = None,
    categories: str | None = None,
    db: Session = Depends(get_db),
    ws: Workspace = Depends(current_workspace),
):
    rows = _reports(db, ws, period, source)
    if not rows:
        scope = _source_label(db, _scope(source))
        raise HTTPException(
            404,
            f"No report for {period or 'the latest period'}"
            + (f" on {scope}." if scope else ".")
            + " Run the analytics batch for this period and source first.",
        )
    return _report_out(rows[0], _categories(categories))


@router.get("/reports", response_model=list[ReportOut])
def list_reports(
    source: str | None = None,
    period: str | None = None,
    categories: str | None = None,
    db: Session = Depends(get_db),
    ws: Workspace = Depends(current_workspace),
):
    wanted = _categories(categories)
    return [_report_out(r, wanted) for r in _reports(db, ws, period, source)]


@router.get("/reports/export.pdf", response_class=Response)
def export_report_pdf(
    source: str | None = None,
    period: str | None = None,
    categories: str | None = None,
    everyPeriod: bool = Query(False, description="Include every period, not just the latest"),
    db: Session = Depends(get_db),
    ws: Workspace = Depends(current_workspace),
):
    """The filtered report as a downloadable PDF.

    Same filters as the page, so what is downloaded is what is on screen. The
    filters themselves are printed on the first page: a report that does not say
    what it covers is a report nobody can check later.
    """
    from app.reporting import render_report_pdf

    wanted = _categories(categories)
    rows = _reports(db, ws, period, source)
    if not everyPeriod:
        rows = rows[:1]

    recommendations = {
        report.id: [
            r for r in report.recommendations if wanted is None or r.category in wanted
        ]
        for report in rows
    }

    pdf = render_report_pdf(
        rows,
        recommendations,
        filters={
            "Source": _source_label(db, _scope(source)) or "All sources",
            "Period": period or ("every period" if everyPeriod else "latest"),
            "Categories": ", ".join(sorted(wanted)) if wanted else "all four",
        },
        workspace_name=ws.name,
    )

    scope = (_source_label(db, _scope(source)) or "all-sources").lower().replace(" ", "-")
    stamp = period or (rows[0].period if rows else "empty")
    filename = f"knowledgepulse-{scope}-{stamp}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --------------------------------------------------------------------------
# Batch trigger
# --------------------------------------------------------------------------

def _run_batch_task(period: str | None, workspace_id: str, source_id: str | None) -> None:
    db = SessionLocal()
    try:
        if period:
            batch.run_batch(db, period, workspace_id, source_id)
        else:
            # No period named: every period, and every source within it, so one
            # run brings the whole archive up to date.
            batch.run_for_all_periods(db, workspace_id, per_source=True)
    finally:
        db.close()


@router.post("/analytics/run", status_code=202)
def trigger_batch(
    tasks: BackgroundTasks,
    period: str | None = None,
    source: str | None = None,
    ws: Workspace = Depends(current_workspace),
):
    """Kick off the analytics batch. Returns immediately; it takes minutes.

    With no period it runs every period that has traffic, for the workspace as a
    whole and once per source. Name a period to redo just that one, and a source
    to redo just that site within it.
    """
    source_id = _scope(source)
    tasks.add_task(_run_batch_task, period, ws.id, source_id)
    return {
        "status": "started",
        "period": period or "all periods",
        "source": source_id or "all sources",
    }


# --------------------------------------------------------------------------
# Evaluation
# --------------------------------------------------------------------------

@router.get("/evaluation/latest", response_model=EvaluationOut)
def latest_evaluation(db: Session = Depends(get_db), ws: Workspace = Depends(current_workspace)):
    run = (
        db.query(EvaluationRun)
        .filter(EvaluationRun.workspace_id == ws.id)
        .order_by(EvaluationRun.ran_at.desc())
        .first()
    )
    if run is None:
        raise HTTPException(404, "No evaluation run yet. Run scripts/run_evaluation.py.")
    return EvaluationOut(
        id=run.id,
        ranAt=run.ran_at,
        questionCount=run.question_count,
        faithfulness=run.faithfulness,
        answerRelevance=run.answer_relevance,
        contextRelevance=run.context_relevance,
        failures=run.failures or [],
        skippedCount=run.skipped_count or 0,
        perQuestion=run.per_question or [],
        targets={
            "faithfulness": settings.eval_target_faithfulness,
            "answerRelevance": settings.eval_target_answer_relevance,
            "contextRelevance": settings.eval_target_context_relevance,
        },
    )
