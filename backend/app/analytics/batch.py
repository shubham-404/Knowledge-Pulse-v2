"""The scheduled job. Reads a period's conversations, writes topics and a report.

Runs start to finish in one function because that is what it is: a batch. Splitting
it across a queue would add moving parts without adding anything.

Idempotent. Re-running for a period deletes that period's clusters and report
first, so you can tune the weights and run it again without cleaning up by hand.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

import numpy as np
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import embeddings
from app.analytics import clustering, recommend, trends
from app.config import settings
from app.models import (
    DEFAULT_WORKSPACE_ID,
    ClusterMember,
    Conversation,
    Message,
    Recommendation,
    Report,
    Source,
    TopicCluster,
)
from app.tenant import organization_of

log = logging.getLogger(__name__)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def previous_period(period: str) -> str:
    year, month = (int(p) for p in period.split("-"))
    return f"{year - 1}-12" if month == 1 else f"{year}-{month - 1:02d}"


def run_batch(
    db: Session,
    period: str,
    workspace_id: str = DEFAULT_WORKSPACE_ID,
    source_id: str | None = None,
) -> Report | None:
    """Cluster and report on one period.

    source_id narrows the batch to the questions that were answered from one
    knowledge source. A workspace holding five documentation sites can therefore
    carry one set of topics for the whole workspace and one set per site, in the
    same period, without any of them overwriting the others: every row is keyed
    by (period, workspace, source), and re-running a scope only clears its own.
    """
    scope = source_id or "all sources"
    log.info("Analytics batch starting for %s in %s (%s)", period, workspace_id, scope)
    organization_id = organization_of(db, workspace_id)
    source_label = _source_label(db, source_id)

    query = db.query(Message).filter(
        Message.workspace_id == workspace_id,
        Message.role == "customer",
        Message.period == period,
    )
    if source_id:
        query = query.filter(Message.source_id == source_id)
    questions = query.order_by(Message.created_at).all()

    if len(questions) < settings.hdbscan_min_cluster_size * 2:
        log.warning(
            "Only %d questions in %s (%s); need at least %d to cluster, nothing to analyse",
            len(questions), period, scope, settings.hdbscan_min_cluster_size * 2,
        )
        return None

    _clear_period(db, period, workspace_id, source_id)

    texts = [q.text for q in questions]
    confidences = [q.confidence if q.confidence is not None else 0.0 for q in questions]

    log.info("Embedding %d questions", len(texts))
    vectors = embeddings.embed(texts)

    clusters = clustering.cluster_queries(texts, vectors, confidences)
    if not clusters:
        log.warning("No topics emerged for %s", period)
        return None

    # Growth is measured against the same scope a period earlier, never against
    # a different site's topics.
    prior = (
        db.query(TopicCluster)
        .filter(
            TopicCluster.workspace_id == workspace_id,
            TopicCluster.period == previous_period(period),
            TopicCluster.source_id.is_(None) if source_id is None else TopicCluster.source_id == source_id,
        )
        .all()
    )
    max_volume = max(len(c.indices) for c in clusters)

    rows: list[TopicCluster] = []
    for cluster in clusters:
        matched, _ = trends.match_to_previous(cluster.centroid, prior)
        previous_count = matched.query_count if matched else 0
        count = len(cluster.indices)
        growth = trends.compute_growth(count, previous_count)

        row = TopicCluster(
            id=new_id("ins"),
            organization_id=organization_id,
            workspace_id=workspace_id,
            period=period,
            source_id=source_id,
            source_label=source_label,
            name=cluster.name,
            keywords=cluster.keywords,
            query_count=count,
            previous_query_count=previous_count,
            growth=growth,
            mean_confidence=cluster.mean_confidence,
            severity=cluster.severity,
            trend=trends.classify_trend(count, previous_count, growth),
            centroid=[float(x) for x in cluster.centroid],
            previous_cluster_id=matched.id if matched else None,
            priority=trends.priority_score(
                volume_norm=count / max_volume,
                growth=growth,
                mean_confidence=cluster.mean_confidence,
                severity=cluster.severity,
            ),
        )
        db.add(row)
        db.flush()
        for index in cluster.indices:
            db.add(
                ClusterMember(
                    organization_id=organization_id,
                    cluster_id=row.id,
                    message_id=questions[index].id,
                )
            )
        rows.append(row)

    rows.sort(key=lambda r: -r.priority)
    for position, row in enumerate(rows, start=1):
        row.rank = position
    db.commit()

    report = _build_report(
        db, period, rows, questions, workspace_id, organization_id, source_id, source_label
    )
    log.info("Batch complete: %d topics, %d recommendations", len(rows), len(report.recommendations))
    return report


def _source_label(db: Session, source_id: str | None) -> str | None:
    if not source_id:
        return None
    source = db.get(Source, source_id)
    return source.label if source else None


def _scope(column, source_id: str | None):
    """Match rows of exactly this scope: one source, or the unscoped whole."""
    return column.is_(None) if source_id is None else column == source_id


def _clear_period(db: Session, period: str, workspace_id: str, source_id: str | None = None) -> None:
    """Remove only the rows this scope owns, so the other scopes survive."""
    old_clusters = (
        db.query(TopicCluster)
        .filter(
            TopicCluster.workspace_id == workspace_id,
            TopicCluster.period == period,
            _scope(TopicCluster.source_id, source_id),
        )
        .all()
    )
    for cluster in old_clusters:
        db.delete(cluster)
    old_reports = (
        db.query(Report)
        .filter(
            Report.workspace_id == workspace_id,
            Report.period == period,
            _scope(Report.source_id, source_id),
        )
        .all()
    )
    for old_report in old_reports:
        db.delete(old_report)
    db.commit()


def _build_report(
    db: Session,
    period: str,
    rows: list[TopicCluster],
    questions: list[Message],
    workspace_id: str,
    organization_id: str,
    source_id: str | None = None,
    source_label: str | None = None,
) -> Report:
    low = sum(1 for q in questions if (q.confidence or 0) < settings.low_confidence_threshold)
    unanswered_rate = round(low / len(questions), 4)

    conversation_query = db.query(func.count(func.distinct(Message.conversation_id))).filter(
        Message.workspace_id == workspace_id, Message.period == period
    )
    if source_id:
        conversation_query = conversation_query.filter(Message.source_id == source_id)
    conversation_count = conversation_query.scalar() or 0

    report = Report(
        id=new_id("rep"),
        organization_id=organization_id,
        workspace_id=workspace_id,
        period=period,
        source_id=source_id,
        source_label=source_label,
        generated_at=datetime.now(timezone.utc),
        conversation_count=conversation_count,
        query_count=len(questions),
        unanswered_rate=unanswered_rate,
        summary=recommend.write_summary(period, rows, unanswered_rate),
    )
    db.add(report)
    db.flush()

    # Only the top of the ranked list becomes a recommendation. A report with
    # eighteen actions on it is a report nobody acts on.
    top = rows[:6]
    volumes = sorted(r.query_count for r in rows)
    median_volume = volumes[len(volumes) // 2]

    for row in top:
        samples = _sample_questions(db, row.id, limit=8)
        category = recommend.choose_category(row, median_volume)
        db.add(recommend.write_recommendation(row, category, samples, report.id, organization_id))

    db.commit()
    db.refresh(report)
    return report


def _sample_questions(db: Session, cluster_id: str, limit: int = 5) -> list[str]:
    """Prefer the lowest-confidence questions: they show the failure most clearly."""
    result = (
        db.query(Message.text)
        .join(ClusterMember, ClusterMember.message_id == Message.id)
        .filter(ClusterMember.cluster_id == cluster_id)
        .order_by(Message.confidence.asc())
        .limit(limit)
        .all()
    )
    return [r[0] for r in result]


def latest_period(db: Session, workspace_id: str = DEFAULT_WORKSPACE_ID) -> str | None:
    row = db.query(func.max(Message.period)).filter(Message.workspace_id == workspace_id).scalar()
    return row or None


def analysable_periods(db: Session, workspace_id: str = DEFAULT_WORKSPACE_ID) -> list[str]:
    """Every period that has logged questions, oldest first."""
    return [
        p[0]
        for p in db.query(Message.period)
        .filter(Message.workspace_id == workspace_id, Message.role == "customer")
        .distinct()
        .order_by(Message.period)
        if p[0]
    ]


def run_for_all_periods(
    db: Session,
    workspace_id: str = DEFAULT_WORKSPACE_ID,
    per_source: bool = True,
) -> list[Report]:
    """Every period, and by default every source within each period.

    Order matters: each period needs the previous one already clustered before
    growth can be computed, so the periods run oldest first. Within a period the
    whole-workspace scope runs first, then one scope per source that has traffic,
    which is what makes the Insights and Report pages change when you pick a
    different documentation site.
    """
    periods = analysable_periods(db, workspace_id)
    scopes: list[str | None] = [None]
    if per_source:
        scopes += [
            row[0]
            for row in db.query(Message.source_id)
            .filter(
                Message.workspace_id == workspace_id,
                Message.role == "customer",
                Message.source_id.isnot(None),
            )
            .distinct()
            .all()
            if row[0]
        ]

    reports = []
    for scope in scopes:
        for period in periods:
            report = run_batch(db, period, workspace_id, scope)
            if report:
                reports.append(report)
    log.info("Analysed %d period/source combinations, wrote %d reports",
             len(periods) * len(scopes), len(reports))
    return reports
