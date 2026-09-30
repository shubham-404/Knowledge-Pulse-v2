import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, getSession, getWorkspaceId } from "@/lib/api";
import type { ConversationSummary, Message } from "@/lib/types";

// The Ask page's conversation lives here, above the routes, so it survives
// moving between pages: a question still waiting for its answer lands in the
// conversation even if you are on another page when it arrives. The session id
// is kept per organisation and workspace in localStorage, and the turns are
// reloaded from the server, so the conversation also survives a page reload
// or signing out and back in.

interface ConversationState {
  sessionId: string;
  messages: Message[];
  loading: boolean;
  pending: boolean;
  failed: { question: string; error: string } | null;
  historyError: string | null;
  /** Past conversations in this workspace, most recent first. */
  conversations: ConversationSummary[];
  conversationsLoading: boolean;
  send: (question: string, sourceId?: string | null) => void;
  reload: () => void;
  retry: () => void;
  startNew: () => void;
  /** Reopen an earlier conversation. Its turns are refetched from the server. */
  open: (sessionId: string) => void;
}

const ConversationContext = createContext<ConversationState | null>(null);

export function useConversation() {
  const ctx = useContext(ConversationContext);
  if (!ctx) throw new Error("useConversation must be used inside ConversationProvider");
  return ctx;
}

function newSessionId() {
  // randomUUID needs a secure context (https or localhost); fall back elsewhere.
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 6)).join("");
  return `sess_${random.slice(0, 16)}`;
}

function storageKey(workspaceId: string) {
  return `kp.chat.${getSession()?.user.organizationId ?? "none"}.${workspaceId || "default"}`;
}

function storedSessionId(workspaceId: string): string {
  if (!workspaceId) return newSessionId(); // placeholder until the workspace is known
  try {
    const existing = localStorage.getItem(storageKey(workspaceId));
    if (existing) return existing;
    const fresh = newSessionId();
    localStorage.setItem(storageKey(workspaceId), fresh);
    return fresh;
  } catch {
    return newSessionId();
  }
}

/** Mounted once per workspace (the workspace provider remounts it on switch). */
export function ConversationProvider({ children }: { children: ReactNode }) {
  const workspaceId = getWorkspaceId();
  const [sessionId, setSessionId] = useState(() => storedSessionId(workspaceId));
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<{ question: string; error: string } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(Boolean(workspaceId));
  const [listAttempt, setListAttempt] = useState(0);
  // Answers that arrive after "New conversation" belong to the old one; drop them.
  const activeSession = useRef(sessionId);
  const lastSource = useRef<string | null>(null);

  useEffect(() => {
    activeSession.current = sessionId;
    // Until a workspace is chosen the provider is about to remount; skip the fetch.
    if (!workspaceId) return;
    let alive = true;
    setLoading(true);
    setHistoryError(null);
    api
      .getChatHistory(sessionId)
      .then((turns) => {
        if (alive) setMessages(turns);
      })
      .catch((e) => {
        if (alive) setHistoryError((e as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, workspaceId, attempt]);

  // The list of past conversations. Refetched after each answer so a brand-new
  // conversation appears in the sidebar as soon as it has something in it,
  // rather than only after a reload.
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    setConversationsLoading(true);
    api
      .getConversations()
      .then((rows) => alive && setConversations(rows))
      .catch(() => alive && setConversations([]))
      .finally(() => alive && setConversationsLoading(false));
    return () => {
      alive = false;
    };
  }, [workspaceId, listAttempt]);

  const ask = useCallback(
    async (question: string, addTurn: boolean, sourceId?: string | null) => {
      const forSession = sessionId;
      lastSource.current = sourceId ?? null;
      if (addTurn) {
        setMessages((m) => [
          ...m,
          { id: `local_${Date.now()}`, role: "customer", text: question, createdAt: new Date().toISOString() },
        ]);
      }
      setFailed(null);
      setPending(true);
      try {
        const reply = await api.ask(question, forSession, sourceId);
        if (activeSession.current === forSession) {
          setMessages((m) => [...m, reply]);
          setListAttempt((n) => n + 1);
        }
      } catch (e) {
        if (activeSession.current === forSession) setFailed({ question, error: (e as Error).message });
      } finally {
        if (activeSession.current === forSession) setPending(false);
      }
    },
    [sessionId],
  );

  const send = useCallback(
    (text: string, sourceId?: string | null) => {
      const question = text.trim();
      if (!question || pending || loading) return;
      void ask(question, true, sourceId);
    },
    [ask, pending, loading],
  );

  const retry = useCallback(() => {
    if (failed?.question) void ask(failed.question, false, lastSource.current);
  }, [ask, failed]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /**
   * Reopen an earlier conversation. Only the session id changes; the effect
   * above refetches its turns, so nothing is held in memory per conversation
   * and an old thread reads exactly as it was stored.
   */
  const open = useCallback(
    (id: string) => {
      if (id === sessionId) return;
      try {
        localStorage.setItem(storageKey(workspaceId), id);
      } catch {
        // Storage disabled: the choice lasts for this page load.
      }
      setMessages([]);
      setFailed(null);
      setHistoryError(null);
      setPending(false);
      setSessionId(id);
    },
    [sessionId, workspaceId],
  );

  const startNew = useCallback(() => {
    const fresh = newSessionId();
    try {
      localStorage.setItem(storageKey(workspaceId), fresh);
    } catch {
      // Storage disabled: the new conversation lasts for this page load.
    }
    setMessages([]);
    setFailed(null);
    setHistoryError(null);
    setPending(false);
    setSessionId(fresh);
    // The conversation being left is not lost: it is in the list below.
    setListAttempt((n) => n + 1);
  }, [workspaceId]);

  return (
    <ConversationContext.Provider
      value={{
        sessionId,
        messages,
        loading,
        pending,
        failed,
        historyError,
        conversations,
        conversationsLoading,
        send,
        retry,
        reload,
        startNew,
        open,
      }}
    >
      {children}
    </ConversationContext.Provider>
  );
}
