// One place where the interface talks to the outside world.
//
// If VITE_API_BASE_URL is empty the app serves mock data, so the frontend can be
// developed and demonstrated with no backend running. Once FastAPI is up, set the
// variable and every screen switches over. Nothing else in the app changes.

import {
  mockConversations,
  mockEvaluation,
  mockInsightDetail,
  mockInsights,
  mockOverview,
  mockPeriods,
  mockReport,
  mockReportHistory,
  mockResearch,
  mockScopes,
  mockSources,
  mockWorkspaces,
} from "@/mock/data";
import type {
  AuthSession,
  AuthUser,
  BackendState,
  Citation,
  ConversationSummary,
  EvaluationRun,
  Insight,
  InsightDetail,
  Message,
  Overview,
  Period,
  Report,
  ReportSummary,
  ResearchSummary,
  Scope,
  Source,
  SourceKind,
  Workspace,
  WorkspaceInput,
} from "@/lib/types";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "";
export const usingMockData = BASE === "";

const delay = (ms = 260) => new Promise((r) => setTimeout(r, ms));

// ---- session ------------------------------------------------------------------
// Signing in returns a bearer token, kept in localStorage so it survives reloads
// until it expires or the user signs out. The organisation comes from the
// session on the server; the browser never names it.

const SESSION_KEY = "kp.session";

function readStoredSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    return new Date(parsed.expiresAt).getTime() > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

let session: AuthSession | null = readStoredSession();

export const getSession = () => session;

function storeSession(next: AuthSession | null) {
  session = next;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage disabled: the session lasts until the tab closes.
  }
  currentWorkspace = readStoredWorkspace();
}

// Told when the server ends the session (expired, or signed out elsewhere).
type SessionListener = (reason: string) => void;
const sessionListeners = new Set<SessionListener>();
export function onSessionEnded(listener: SessionListener) {
  sessionListeners.add(listener);
  return () => void sessionListeners.delete(listener);
}

function endSession(reason: string) {
  if (!session) return;
  storeSession(null);
  sessionListeners.forEach((l) => l(reason));
}

// ---- workspace ------------------------------------------------------------------
// X-Workspace-Id is sent once a workspace is chosen; without it the backend uses
// the organisation's default workspace. Remembered per organisation, so one
// account never sends another organisation's workspace id.

const workspaceKey = () => `kp.workspace.${session?.user.organizationId ?? "none"}`;

function readStoredWorkspace(): string {
  try {
    return localStorage.getItem(workspaceKey()) || "";
  } catch {
    return "";
  }
}

let currentWorkspace = readStoredWorkspace();

export const getWorkspaceId = () => currentWorkspace;

export function setWorkspaceId(id: string) {
  currentWorkspace = id;
  try {
    localStorage.setItem(workspaceKey(), id);
  } catch {
    // Private mode or storage disabled: the choice lasts for this session only.
  }
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (session) h.Authorization = `Bearer ${session.token}`;
  if (currentWorkspace) h["X-Workspace-Id"] = currentWorkspace;
  return h;
}

/** Turn a failed response into a readable message. FastAPI puts it in `detail`. */
async function failure(res: Response): Promise<Error> {
  const detail = await res
    .json()
    .then((b) => (typeof b?.detail === "string" ? b.detail : null))
    .catch(() => null);
  return new Error(detail ?? `Request failed with status ${res.status}`);
}

/** A 401 means the session is over: sign out everywhere, then report the error. */
async function failed(res: Response): Promise<Error> {
  const error = await failure(res);
  if (res.status === 401) endSession(error.message);
  return error;
}

async function get<T>(path: string, fallback: T): Promise<T> {
  if (usingMockData) {
    await delay();
    return fallback;
  }
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) throw await failed(res);
  return (await res.json()) as T;
}

async function send<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers:
      body instanceof FormData || body === undefined
        ? authHeaders()
        : { ...authHeaders(), "Content-Type": "application/json" },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await failed(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * The filters every analytics read shares. `source` names one indexed site and
 * narrows the whole page to the traffic it answered; omitting it means the
 * whole workspace. Empty values are dropped rather than sent as blanks, so a
 * cleared filter produces the unfiltered URL the backend already handles.
 */
export interface AnalyticsFilters {
  source?: string | null;
  period?: string | null;
  categories?: string[];
  everyPeriod?: boolean;
}

function filterQuery(filters: AnalyticsFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.source) params.set("source", filters.source);
  if (filters.period) params.set("period", filters.period);
  if (filters.categories?.length) params.set("categories", filters.categories.join(","));
  if (filters.everyPeriod) params.set("everyPeriod", "true");
  const query = params.toString();
  return query ? `?${query}` : "";
}

const kindFromFilename = (name: string): SourceKind => {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  return "text";
};

let mockWorkspaceList = [...mockWorkspaces];
// Placeholder mode keeps conversations in memory, so they survive navigation.
const mockHistory = new Map<string, Message[]>();

export const api = {
  // ---- sign-in ---------------------------------------------------------------

  login: async (email: string, password: string): Promise<AuthUser> => {
    if (usingMockData) {
      await delay(400);
      if (!email.trim() || !password) throw new Error("Enter your email and password.");
      const user: AuthUser = { id: "usr_mock", email: email.trim(), name: "Sinchana", organizationId: "org_default" };
      storeSession({ token: "mock", expiresAt: new Date(Date.now() + 14 * 864e5).toISOString(), user });
      return user;
    }
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw await failure(res);
    const next = (await res.json()) as AuthSession;
    storeSession(next);
    return next.user;
  },

  /** Confirms the stored session with the server. Throws if it has ended. */
  me: async (): Promise<AuthUser> => {
    if (!session) throw new Error("Not signed in");
    if (usingMockData) return session.user;
    const user = await get<AuthUser>("/api/auth/me", session.user);
    storeSession({ ...session, user });
    return user;
  },

  logout: async () => {
    const token = session?.token;
    storeSession(null);
    if (usingMockData || !token) return;
    // Best effort: the local session is gone whatever the server says.
    await fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(
      () => undefined,
    );
  },

  // ---- workspaces ------------------------------------------------------------

  getWorkspaces: () => get<Workspace[]>("/api/workspaces", mockWorkspaceList),

  createWorkspace: async (input: WorkspaceInput): Promise<Workspace> => {
    if (usingMockData) {
      await delay(400);
      const created: Workspace = {
        id: `ws_${Math.random().toString(36).slice(2, 8)}`,
        name: input.name,
        description: input.description ?? "",
        chunkTargetWords: input.chunkTargetWords ?? 220,
        chunkOverlapWords: input.chunkOverlapWords ?? 40,
        crawlMaxPages: input.crawlMaxPages ?? 120,
        usesDefaults: input.chunkTargetWords == null && input.chunkOverlapWords == null,
        isDefault: false,
        sourceCount: 0,
        chunkCount: 0,
        questionCount: 0,
        createdAt: new Date().toISOString(),
      };
      mockWorkspaceList = [...mockWorkspaceList, created];
      return created;
    }
    return send<Workspace>("POST", "/api/workspaces", input);
  },

  updateWorkspace: async (id: string, input: Partial<WorkspaceInput>): Promise<Workspace> => {
    if (usingMockData) {
      await delay(400);
      const current = mockWorkspaceList.find((w) => w.id === id);
      if (!current) throw new Error("No workspace with that id");
      const updated: Workspace = {
        ...current,
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        chunkTargetWords: input.chunkTargetWords ?? current.chunkTargetWords,
        chunkOverlapWords: input.chunkOverlapWords ?? current.chunkOverlapWords,
        crawlMaxPages: input.crawlMaxPages ?? current.crawlMaxPages,
        usesDefaults: false,
      };
      mockWorkspaceList = mockWorkspaceList.map((w) => (w.id === id ? updated : w));
      return updated;
    }
    return send<Workspace>("PATCH", `/api/workspaces/${id}`, input);
  },

  deleteWorkspace: async (id: string) => {
    if (usingMockData) {
      await delay(400);
      mockWorkspaceList = mockWorkspaceList.filter((w) => w.id !== id);
      return;
    }
    await send<unknown>("DELETE", `/api/workspaces/${id}`);
  },

  getResearch: () => get<ResearchSummary>("/api/research/latest", mockResearch),

  getOverview: (filters: AnalyticsFilters = {}) =>
    get<Overview>(`/api/overview${filterQuery(filters)}`, mockOverview),

  /** The knowledge sources the archive can be filtered to, newest traffic first. */
  getScopes: () => get<Scope[]>("/api/scopes", mockScopes),

  /** Reachability check for the Sources page. Never throws. */
  getHealth: async (): Promise<BackendState> => {
    if (usingMockData) return "mock";
    try {
      const res = await fetch(`${BASE}/api/health`);
      return res.ok ? "connected" : "unreachable";
    } catch {
      return "unreachable";
    }
  },

  // ---- sources -------------------------------------------------------------

  // In placeholder mode only the first workspace has sources, so switching is visible.
  getSources: () => get<Source[]>("/api/sources", currentWorkspace === "ws_default" ? mockSources : []),

  addSource: async (payload: { kind: SourceKind; location: string; label?: string }) => {
    if (usingMockData) {
      await delay(500);
      const created: Source = {
        id: `src_${Math.random().toString(36).slice(2, 7)}`,
        kind: payload.kind,
        label: payload.label || payload.location.replace(/^https?:\/\//, "").split("/")[0],
        location: payload.location,
        status: "queued",
        pageCount: 0,
        chunkCount: 0,
        lastIndexedAt: null,
        contentHash: null,
      };
      return created;
    }
    return send<Source>("POST", "/api/sources", payload);
  },

  uploadSource: async (file: File, label?: string) => {
    if (usingMockData) {
      await delay(700);
      const created: Source = {
        id: `src_${Math.random().toString(36).slice(2, 7)}`,
        kind: kindFromFilename(file.name),
        label: label || file.name.replace(/\.[^.]+$/, ""),
        location: file.name,
        status: "indexing",
        pageCount: 0,
        chunkCount: 0,
        lastIndexedAt: null,
        contentHash: null,
      };
      return created;
    }
    const form = new FormData();
    form.append("file", file);
    if (label) form.append("label", label);
    return send<Source>("POST", "/api/sources/upload", form);
  },

  reindexSource: async (id: string) => {
    if (usingMockData) {
      await delay(400);
      return;
    }
    await send<unknown>("POST", `/api/sources/${id}/reindex`);
  },

  /** Ask a running crawl or index to stop. It finishes the page or batch it is on. */
  stopSource: async (id: string) => {
    if (usingMockData) {
      await delay(400);
      return;
    }
    await send<unknown>("POST", `/api/sources/${id}/stop`);
  },

  deleteSource: async (id: string) => {
    if (usingMockData) {
      await delay(400);
      return;
    }
    await send<unknown>("DELETE", `/api/sources/${id}`);
  },

  // ---- analytics -----------------------------------------------------------

  /**
   * Kick off the batch. With no period it runs every period that has traffic,
   * for the workspace as a whole and once per source, which is what makes the
   * per-site insights appear.
   */
  runAnalytics: async (filters: AnalyticsFilters = {}) => {
    if (usingMockData) {
      await delay(1200);
      return;
    }
    await send<unknown>("POST", `/api/analytics/run${filterQuery(filters)}`);
  },

  getPeriods: (filters: AnalyticsFilters = {}) =>
    get<Period[]>(`/api/periods${filterQuery(filters)}`, mockPeriods),

  getInsights: (filters: AnalyticsFilters = {}) =>
    get<Insight[]>(`/api/insights${filterQuery(filters)}`, mockInsights),

  getInsight: async (id: string) => {
    if (usingMockData) {
      await delay();
      const detail = mockInsightDetail[id];
      if (detail) return detail;
      // Synthesise a plausible detail view for the other mock insights.
      const base = mockInsights.find((i) => i.id === id);
      if (!base) throw new Error("No insight with that id");
      return {
        ...base,
        history: [
          { period: "Jun", queries: Math.round(base.previousQueryCount * 0.8), meanConfidence: base.meanConfidence + 0.06 },
          { period: "Jul", queries: base.previousQueryCount, meanConfidence: base.meanConfidence + 0.03 },
          { period: "Aug", queries: base.queryCount, meanConfidence: base.meanConfidence },
        ],
        memberQueries: base.sampleQueries.map((text, n) => ({
          id: `q_${id}_${n}`,
          text,
          confidence: base.meanConfidence,
          askedAt: "2026-08-21T10:00:00Z",
        })),
        weakestChunks: [] as Citation[],
      } satisfies InsightDetail;
    }
    return get<InsightDetail>(`/api/insights/${id}`, {} as InsightDetail);
  },

  // ---- reports and evaluation ---------------------------------------------

  getReport: (filters: AnalyticsFilters = {}) =>
    get<Report>(`/api/reports/latest${filterQuery(filters)}`, mockReport),

  getReports: (filters: AnalyticsFilters = {}) =>
    get<ReportSummary[]>(`/api/reports${filterQuery(filters)}`, mockReportHistory),

  /**
   * Download the filtered report as a PDF.
   *
   * fetch rather than pointing the browser at the URL, because the endpoint
   * needs the bearer token and a plain link cannot carry one. The blob is
   * handed to a temporary anchor and revoked straight after, so nothing is
   * left holding the file in memory.
   */
  downloadReportPdf: async (filters: AnalyticsFilters = {}): Promise<string> => {
    if (usingMockData) {
      await delay(700);
      throw new Error("Connect the backend to download a PDF. Placeholder data has no report to render.");
    }
    const res = await fetch(`${BASE}/api/reports/export.pdf${filterQuery(filters)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) throw await failed(res);

    const disposition = res.headers.get("Content-Disposition") ?? "";
    const name = /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? "knowledgepulse-report.pdf";
    const url = URL.createObjectURL(await res.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return name;
  },

  getEvaluation: () => get<EvaluationRun>("/api/evaluation/latest", mockEvaluation),

  // ---- chat ----------------------------------------------------------------

  /** Past conversations in this workspace, most recent first. */
  getConversations: async (): Promise<ConversationSummary[]> => {
    if (usingMockData) {
      await delay(200);
      return [...mockConversations];
    }
    return get<ConversationSummary[]>("/api/chat/conversations", []);
  },

  getChatHistory: async (sessionId: string): Promise<Message[]> => {
    if (usingMockData) {
      await delay(200);
      return [...(mockHistory.get(sessionId) ?? [])];
    }
    return get<Message[]>(`/api/chat/history?session_id=${encodeURIComponent(sessionId)}`, []);
  },

  ask: async (question: string, sessionId: string, sourceId?: string | null): Promise<Message> => {
    if (usingMockData) {
      await delay(900);
      const turn: Message = { id: `msg_q_${Date.now()}`, role: "customer", text: question, createdAt: new Date().toISOString() };
      const reply: Message = {
        id: `msg_${Date.now()}`,
        role: "assistant",
        text: "Recurring invoices are generated on the schedule you set and sent to the client's registered email. If a charge did not go through, the invoice will still show as unpaid and you can send a reminder from the invoice page.\n\nI could not find anything in the indexed sources about mandate revocation or bank decline reasons, so this answer may not cover what you are asking.",
        createdAt: new Date().toISOString(),
        confidence: 0.28,
        citations: [
          {
            chunkId: "chk_00412",
            sourceLabel: "Kestrel documentation",
            headingPath: "Payments › Recurring invoices",
            similarity: 0.34,
            excerpt:
              "Recurring invoices are generated on the schedule you set and sent to the client's registered email address.",
          },
          {
            chunkId: "chk_00877",
            sourceLabel: "Kestrel onboarding handbook",
            headingPath: "Getting paid › Payment methods",
            similarity: 0.31,
            excerpt:
              "Clients can pay by card, net banking or UPI. Payment status appears on the invoice within a few minutes.",
          },
        ],
      };
      mockHistory.set(sessionId, [...(mockHistory.get(sessionId) ?? []), turn, reply]);
      return reply;
    }
    return send<Message>("POST", "/api/chat", {
      question,
      session_id: sessionId,
      source_id: sourceId || null,
    });
  },
};
