// These mirror the seven entities in the report's data model (Section 7.2.4).
// Keep them in sync with the Pydantic schemas once the backend lands.

export type SourceKind = "website" | "pdf" | "docx" | "text";
export type SourceStatus = "queued" | "crawling" | "indexing" | "ready" | "failed" | "stopping" | "stopped";

export interface Source {
  id: string;
  kind: SourceKind;
  label: string;
  location: string; // URL or original filename
  status: SourceStatus;
  pageCount: number;
  chunkCount: number;
  lastIndexedAt: string | null;
  contentHash: string | null;
  error?: string;
}

export interface Citation {
  chunkId: string;
  sourceLabel: string;
  headingPath: string;
  similarity: number;
  excerpt: string;
}

export interface Message {
  id: string;
  role: "customer" | "assistant";
  text: string;
  createdAt: string;
  confidence?: number; // retrieval confidence, assistant turns only
  citations?: Citation[];
}

/** One knowledge source the archive can be filtered to. `sourceId` null is "everything". */
export interface Scope {
  sourceId: string | null;
  label: string;
  questionCount: number;
  analysed: boolean;
}

/** A reporting period, and whether the analytics batch has been run over it. */
export interface Period {
  period: string;
  queryCount: number;
  analysed: boolean;
  topicCount: number;
}

/** One past conversation, enough to list it and reopen it. */
export interface ConversationSummary {
  sessionId: string;
  startedAt: string;
  lastMessageAt: string;
  turnCount: number;
  title: string;
  meanConfidence: number | null;
}

export type TrendState = "recurring" | "emerging" | "stable";

export interface Insight {
  id: string;
  rank: number;
  name: string;
  keywords: string[];
  queryCount: number;
  previousQueryCount: number;
  growth: number; // -1..n, period over period
  meanConfidence: number; // 0..1
  severity: number; // 0..1, inferred
  priority: number; // 0..1, weighted composite
  trend: TrendState;
  sampleQueries: string[];
  sourceId?: string | null;
  sourceLabel?: string | null;
}

export interface TrendPoint {
  period: string;
  queries: number;
  meanConfidence: number;
}

export interface InsightDetail extends Insight {
  history: TrendPoint[];
  memberQueries: { id: string; text: string; confidence: number; askedAt: string }[];
  weakestChunks: Citation[];
}

export type ActionCategory = "product" | "documentation" | "faq" | "customer_issue";

export interface Recommendation {
  id: string;
  category: ActionCategory;
  headline: string;
  body: string;
  insightId: string;
  insightName: string;
  supportingQueries: string[];
  volume: number;
  growth: number;
  expectedEffect: string;
  faqAnswer?: string; // FAQ recommendations carry a draft answer
}

export interface Report {
  id: string;
  period: string;
  sourceId?: string | null;
  sourceLabel?: string | null;
  generatedAt: string;
  conversationCount: number;
  queryCount: number;
  unansweredRate: number;
  summary: string;
  recommendations: Recommendation[];
}

export interface EvaluationRun {
  id: string;
  ranAt: string;
  questionCount: number;
  faithfulness: number;
  answerRelevance: number;
  contextRelevance: number;
  failures: { question: string; metric: string; score: number }[];
  /** Questions the judge could not complete. Reported, never scored as zero. */
  skippedCount?: number;
  perQuestion?: {
    question: string;
    confidence: number;
    retrieved: number;
    faithfulness: number;
    answer_relevance: number;
    context_relevance: number;
  }[];
  /** Targets come from the backend so the page and NFR4 cannot drift apart. */
  targets?: Partial<Record<"faithfulness" | "answerRelevance" | "contextRelevance", number>>;
}

export interface Overview {
  period: string;
  sourceLabel?: string | null;
  conversationCount: number;
  queryCount: number;
  topicCount: number;
  unansweredRate: number;
  meanConfidence: number;
  emergingCount: number;
  volumeByPeriod: TrendPoint[];
}

/** One row of the report archive. The full report is fetched separately. */
export interface ReportSummary {
  id: string;
  period: string;
  sourceId?: string | null;
  sourceLabel?: string | null;
  generatedAt: string;
  conversationCount: number;
  queryCount: number;
  unansweredRate: number;
  summary: string;
}

/** "mock" when running on placeholder data, otherwise whether the API answered. */
export type BackendState = "mock" | "connected" | "unreachable";

/** A fully separate profile: its own sources, chats, insights and reports. */
export interface Workspace {
  id: string;
  name: string;
  description: string;
  chunkTargetWords: number;
  chunkOverlapWords: number;
  crawlMaxPages: number;
  usesDefaults: boolean;
  /** The organisation's default workspace. It cannot be deleted. */
  isDefault: boolean;
  sourceCount: number;
  chunkCount: number;
  questionCount: number;
  createdAt: string;
}

export interface WorkspaceInput {
  name: string;
  description?: string;
  chunkTargetWords?: number | null;
  chunkOverlapWords?: number | null;
  crawlMaxPages?: number | null;
}

// ---- research experiment (python -m research.run) ---------------------------

export interface ResearchRetrieval {
  answerable: number;
  unanswerable: number;
  hit1: number | null;
  hitk: number | null;
  mrr: number | null;
  recallk: number | null;
  page_hitk: number | null;
  context_words: number | null;
  mean_conf_answerable: number | null;
  mean_conf_unanswerable: number | null;
  auroc: number | null;
  tau: number;
  false_gap: number | null;
  missed_gap: number | null;
  balanced_accuracy: number | null;
  best_tau: number | null;
}

export interface ResearchChunkStats {
  chunks: number;
  words: { mean: number; median: number; p10: number; p90: number };
  tiny_rate: number;
  cross_section_rate: number;
  code_blocks: number;
  code_split_rate: number | null;
}

export interface ResearchResult {
  site: string;
  config: string;
  chunker: string;
  size: number;
  chunk_stats: ResearchChunkStats;
  retrieval: ResearchRetrieval;
}

export interface ResearchSite {
  site: string;
  name: string;
  generator: string;
  pages: number;
  words: number;
  crawled_at: string;
  questions: number;
  review: { generated: number; reviewed: number; accepted_of_reviewed: number; acceptance_rate: number | null };
}

export interface ResearchComparison {
  site: string;
  config: string;
  baseline: string;
  metric: string;
  mean_diff: number | null;
  ci_low: number | null;
  ci_high: number | null;
  significant: boolean;
}

export interface ResearchTransfer {
  config: string;
  from: string;
  to: string;
  tau: number;
  balanced_transferred: number | null;
  balanced_own: number | null;
}

export interface ResearchSummary {
  run_id: string;
  created_at: string;
  embedding_model: string;
  k: number;
  tau: number;
  overlap: number;
  sizes: number[];
  chunkers: string[];
  relevance_threshold: number;
  containment_threshold: number;
  sites: ResearchSite[];
  results: ResearchResult[];
  comparisons: ResearchComparison[];
  transfer: ResearchTransfer[];
}

/** The signed-in user. The organisation is fixed by the account, not chosen in the browser. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  organizationId: string;
}

/** What /api/auth/login returns; kept in localStorage until it expires or the user signs out. */
export interface AuthSession {
  token: string;
  expiresAt: string;
  user: AuthUser;
}
