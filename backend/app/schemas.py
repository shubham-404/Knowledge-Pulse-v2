"""Response shapes. These are the contract with the frontend.

Field names are camelCase because that is what src/lib/types.ts expects; the
aliasing happens here rather than making the frontend translate.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


class Base(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class CitationOut(Base):
    chunkId: str
    sourceLabel: str
    headingPath: str
    similarity: float
    excerpt: str


class SourceOut(Base):
    id: str
    kind: str
    label: str
    location: str
    status: str
    pageCount: int
    chunkCount: int
    lastIndexedAt: datetime | None
    contentHash: str | None
    error: str | None = None


class SourceCreate(Base):
    kind: Literal["website", "pdf", "docx", "text"] = "website"
    location: str
    label: str | None = None


class ChatRequest(Base):
    question: str
    session_id: str
    # Answer from one indexed site only. Omitted means every source in the
    # workspace, which is the old behaviour.
    source_id: str | None = None


class ConversationOut(Base):
    """One past conversation, enough to list and reopen it."""

    sessionId: str
    startedAt: datetime
    lastMessageAt: datetime
    turnCount: int
    title: str
    meanConfidence: float | None = None


class MessageOut(Base):
    id: str
    role: str
    text: str
    createdAt: datetime
    confidence: float | None = None
    citations: list[CitationOut] = []


class InsightOut(Base):
    id: str
    rank: int
    name: str
    keywords: list[str]
    queryCount: int
    previousQueryCount: int
    growth: float
    meanConfidence: float
    severity: float
    priority: float
    trend: str
    sampleQueries: list[str]
    sourceId: str | None = None
    sourceLabel: str | None = None


class TrendPointOut(Base):
    period: str
    queries: int
    meanConfidence: float


class MemberQueryOut(Base):
    id: str
    text: str
    confidence: float
    askedAt: datetime


class InsightDetailOut(InsightOut):
    history: list[TrendPointOut]
    memberQueries: list[MemberQueryOut]
    weakestChunks: list[CitationOut]


class RecommendationOut(Base):
    id: str
    category: str
    headline: str
    body: str
    insightId: str
    insightName: str
    supportingQueries: list[str]
    volume: int
    growth: float
    expectedEffect: str
    faqAnswer: str | None = None


class PeriodOut(Base):
    """One reporting period, and whether the analytics batch has run over it."""

    period: str
    queryCount: int
    analysed: bool
    topicCount: int


class ScopeOut(Base):
    """One knowledge source the archive can be filtered to."""

    sourceId: str | None = None
    label: str
    questionCount: int
    analysed: bool


class ReportOut(Base):
    id: str
    period: str
    sourceId: str | None = None
    sourceLabel: str | None = None
    generatedAt: datetime
    conversationCount: int
    queryCount: int
    unansweredRate: float
    summary: str
    recommendations: list[RecommendationOut]


class EvaluationOut(Base):
    id: str
    ranAt: datetime
    questionCount: int
    faithfulness: float
    answerRelevance: float
    contextRelevance: float
    failures: list[dict]
    # Questions whose judge calls could not be completed. Reported rather than
    # scored zero, so a rate-limited run is not mistaken for a bad assistant.
    skippedCount: int = 0
    perQuestion: list[dict] = []
    targets: dict[str, float] = {}


class OverviewOut(Base):
    period: str
    sourceLabel: str | None = None
    conversationCount: int
    queryCount: int
    topicCount: int
    unansweredRate: float
    meanConfidence: float
    emergingCount: int
    volumeByPeriod: list[TrendPointOut]


class WorkspaceOut(Base):
    id: str
    name: str
    description: str
    chunkTargetWords: int
    chunkOverlapWords: int
    crawlMaxPages: int
    usesDefaults: bool
    isDefault: bool
    sourceCount: int
    chunkCount: int
    questionCount: int
    createdAt: datetime


class WorkspaceCreate(Base):
    name: str
    description: str = ""
    chunkTargetWords: int | None = None
    chunkOverlapWords: int | None = None
    crawlMaxPages: int | None = None


class WorkspaceUpdate(Base):
    name: str | None = None
    description: str | None = None
    chunkTargetWords: int | None = None
    chunkOverlapWords: int | None = None
    crawlMaxPages: int | None = None


# ---- sign-in ------------------------------------------------------------------

class LoginRequest(BaseModel):
    email: str
    password: str


class UserOut(Base):
    id: str
    email: str
    name: str
    organizationId: str


class SessionOut(Base):
    token: str
    expiresAt: datetime
    user: UserOut
