"""The seven entities from Section 7.2.4 of the project report, plus two join
and bookkeeping tables.

The chain that matters runs: message -> retrieved chunk ids -> chunk -> source.
Every finding downstream can be walked back along it, which is what makes
NFR5 (explainability) true rather than aspirational.

Tenancy is two levels. An organisation (the tenant, identified by the
X-Organization-Id header) owns workspaces; a workspace owns sources,
conversations, topics, reports and evaluation runs. Every tenant-owned row
carries organization_id, and the rows a workspace owns carry workspace_id too.
Neither column has a default: a row created without them fails to insert
rather than landing silently in someone else's data.
"""

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import Float, ForeignKey, Index, Integer, JSON, String, Text, DateTime
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def now() -> datetime:
    return datetime.now(timezone.utc)


# Every pre-workspace row is migrated into this one, so existing data keeps working.
# It is the default workspace of the default organisation; every other
# organisation gets its own (see app.tenant.default_workspace_id).
DEFAULT_WORKSPACE_ID = "ws_default"


def _organization_column() -> Mapped[str]:
    return mapped_column(String(64), nullable=False, index=True)


class Workspace(Base):
    """A fully separate profile: its own sources, conversations, topics and reports.

    Belongs to one organisation, which may have several: one per product, or one
    per documentation site in the research experiments. The chunk settings are
    per workspace so two sites can be indexed differently.
    """

    __tablename__ = "workspaces"
    __table_args__ = (Index("ix_workspaces_org_created_at", "organization_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    organization_id: Mapped[str] = _organization_column()
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    # Null means "use the global default from config".
    chunk_target_words: Mapped[int | None] = mapped_column(Integer, nullable=True)
    chunk_overlap_words: Mapped[int | None] = mapped_column(Integer, nullable=True)
    crawl_max_pages: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


def _workspace_column() -> Mapped[str]:
    return mapped_column(String(40), nullable=False, index=True)


class Source(Base):
    __tablename__ = "sources"
    __table_args__ = (Index("ix_sources_org_created_at", "organization_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    organization_id: Mapped[str] = _organization_column()
    workspace_id: Mapped[str] = _workspace_column()
    kind: Mapped[str] = mapped_column(String(16))  # website | pdf | docx | text
    label: Mapped[str] = mapped_column(String(200))
    location: Mapped[str] = mapped_column(Text)
    # queued | crawling | indexing | ready | failed | stopping | stopped
    status: Mapped[str] = mapped_column(String(16), default="queued")
    page_count: Mapped[int] = mapped_column(Integer, default=0)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    last_indexed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

    chunks: Mapped[list["Chunk"]] = relationship(back_populates="source", cascade="all, delete-orphan")


class Chunk(Base):
    __tablename__ = "chunks"
    __table_args__ = (Index("ix_chunks_org_source_id", "organization_id", "source_id"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    organization_id: Mapped[str] = _organization_column()
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"), index=True)
    heading_path: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str | None] = mapped_column(Text, nullable=True)
    text: Mapped[str] = mapped_column(Text)
    word_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

    source: Mapped[Source] = relationship(back_populates="chunks")


class Conversation(Base):
    __tablename__ = "conversations"
    __table_args__ = (Index("ix_conversations_org_session_id", "organization_id", "session_id"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    organization_id: Mapped[str] = _organization_column()
    workspace_id: Mapped[str] = _workspace_column()
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    # Set for generated traffic so the archive can always be audited or filtered.
    synthetic: Mapped[bool] = mapped_column(default=False)

    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan"
    )


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        Index("ix_messages_org_period", "organization_id", "period"),
        Index("ix_messages_org_created_at", "organization_id", "created_at"),
        Index("ix_messages_org_conversation_id", "organization_id", "conversation_id"),
    )

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    organization_id: Mapped[str] = _organization_column()
    workspace_id: Mapped[str] = _workspace_column()
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(12))  # customer | assistant
    text: Mapped[str] = mapped_column(Text)
    # Assistant turns only. Computed from retrieval similarity before generation.
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    retrieved_chunk_ids: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    retrieved_scores: Mapped[list[float] | None] = mapped_column(JSON, nullable=True)
    # Assistant turns: the citations exactly as shown, so a conversation reloads
    # intact even after its sources are reindexed and the chunk ids change.
    citations: Mapped[list[dict] | None] = mapped_column(JSON, nullable=True)
    # The knowledge source this turn was actually answered from: the source
    # owning the best-scoring retrieved chunk. Null for turns logged before
    # source attribution existed, or when nothing was retrieved. This is what
    # lets one workspace hold several documentation sites and still report on
    # them separately.
    source_id: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    source_label: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)
    # Reporting period this turn belongs to, e.g. "2026-08". Set on write so the
    # analytics batch never has to reason about calendars.
    period: Mapped[str] = mapped_column(String(16), index=True, default="")

    conversation: Mapped[Conversation] = relationship(back_populates="messages")


class TopicCluster(Base):
    __tablename__ = "topic_clusters"
    __table_args__ = (Index("ix_topic_clusters_org_period", "organization_id", "period"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    organization_id: Mapped[str] = _organization_column()
    workspace_id: Mapped[str] = _workspace_column()
    period: Mapped[str] = mapped_column(String(16), index=True)
    # Which source's traffic this topic was clustered from. Null means the whole
    # workspace, every source together. A period can hold both: one unscoped set
    # of topics and one set per source, side by side.
    source_id: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    source_label: Mapped[str | None] = mapped_column(String(200), nullable=True)
    rank: Mapped[int] = mapped_column(Integer, default=0)
    name: Mapped[str] = mapped_column(Text)
    keywords: Mapped[list[str]] = mapped_column(JSON, default=list)
    query_count: Mapped[int] = mapped_column(Integer, default=0)
    previous_query_count: Mapped[int] = mapped_column(Integer, default=0)
    growth: Mapped[float] = mapped_column(Float, default=0.0)
    mean_confidence: Mapped[float] = mapped_column(Float, default=0.0)
    severity: Mapped[float] = mapped_column(Float, default=0.0)
    priority: Mapped[float] = mapped_column(Float, default=0.0)
    trend: Mapped[str] = mapped_column(String(16), default="stable")
    centroid: Mapped[list[float]] = mapped_column(JSON, default=list)
    previous_cluster_id: Mapped[str | None] = mapped_column(String(40), nullable=True)

    members: Mapped[list["ClusterMember"]] = relationship(
        back_populates="cluster", cascade="all, delete-orphan"
    )


class ClusterMember(Base):
    __tablename__ = "cluster_members"
    __table_args__ = (Index("ix_cluster_members_org_cluster_id", "organization_id", "cluster_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    organization_id: Mapped[str] = _organization_column()
    cluster_id: Mapped[str] = mapped_column(ForeignKey("topic_clusters.id", ondelete="CASCADE"), index=True)
    message_id: Mapped[str] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"))

    cluster: Mapped[TopicCluster] = relationship(back_populates="members")


class Report(Base):
    __tablename__ = "reports"
    __table_args__ = (Index("ix_reports_org_period", "organization_id", "period"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    organization_id: Mapped[str] = _organization_column()
    workspace_id: Mapped[str] = _workspace_column()
    period: Mapped[str] = mapped_column(String(16), index=True)
    source_id: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    source_label: Mapped[str | None] = mapped_column(String(200), nullable=True)
    generated_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    conversation_count: Mapped[int] = mapped_column(Integer, default=0)
    query_count: Mapped[int] = mapped_column(Integer, default=0)
    unanswered_rate: Mapped[float] = mapped_column(Float, default=0.0)
    summary: Mapped[str] = mapped_column(Text, default="")

    recommendations: Mapped[list["Recommendation"]] = relationship(
        back_populates="report", cascade="all, delete-orphan"
    )


class Recommendation(Base):
    __tablename__ = "recommendations"
    __table_args__ = (Index("ix_recommendations_org_report_id", "organization_id", "report_id"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    organization_id: Mapped[str] = _organization_column()
    report_id: Mapped[str] = mapped_column(ForeignKey("reports.id", ondelete="CASCADE"), index=True)
    cluster_id: Mapped[str] = mapped_column(String(40))
    cluster_name: Mapped[str] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(24))  # product|documentation|faq|customer_issue
    headline: Mapped[str] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text)
    faq_answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    supporting_queries: Mapped[list[str]] = mapped_column(JSON, default=list)
    volume: Mapped[int] = mapped_column(Integer, default=0)
    growth: Mapped[float] = mapped_column(Float, default=0.0)
    expected_effect: Mapped[str] = mapped_column(Text, default="")

    report: Mapped[Report] = relationship(back_populates="recommendations")


class EvaluationRun(Base):
    __tablename__ = "evaluation_runs"
    __table_args__ = (Index("ix_evaluation_runs_org_ran_at", "organization_id", "ran_at"),)

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    organization_id: Mapped[str] = _organization_column()
    workspace_id: Mapped[str] = _workspace_column()
    ran_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    question_count: Mapped[int] = mapped_column(Integer, default=0)
    faithfulness: Mapped[float] = mapped_column(Float, default=0.0)
    answer_relevance: Mapped[float] = mapped_column(Float, default=0.0)
    context_relevance: Mapped[float] = mapped_column(Float, default=0.0)
    failures: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    # Questions whose judge calls could not be completed at all (quota, timeout).
    # Counted and reported rather than silently scored zero, which would make a
    # rate-limited run look like a bad assistant.
    skipped_count: Mapped[int] = mapped_column(Integer, default=0)
    per_question: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)


# ---- sign-in -------------------------------------------------------------------

def utcnow_naive() -> datetime:
    """UTC without tzinfo: stored and compared the same way on SQLite and Postgres."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(Base):
    """Someone who can sign in. Belongs to exactly one organisation for now."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    organization_id: Mapped[str] = _organization_column()
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive)


class AuthSession(Base):
    """One signed-in browser. The token itself is never stored, only its hash."""

    __tablename__ = "auth_sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # sha256 of the token
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow_naive)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)

    user: Mapped[User] = relationship()
