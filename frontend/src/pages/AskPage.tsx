import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { MessageSquarePlus } from "lucide-react";
import { usingMockData } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { Button, PageContainer, PageHeader, Panel, Skeleton } from "@/components/ui";
import {
  AssistantMessageBubble,
  ChatComposer,
  ChatEmptyState,
  ChatError,
  ChatLoadingBubble,
  UserMessageBubble,
} from "@/components/ask/chat";
import { useConversation } from "@/components/ask/conversation";
import { SourceFilter, useScope } from "@/components/filters";

// The placeholder data describes an invoicing product; the live demo indexes
// the Plausible Analytics docs. Examples follow whichever is on screen.
const examples = usingMockData
  ? [
      "Can I edit an invoice after I've sent it?",
      "Why did my client's autopay not go through?",
      "Where do I add an LUT number for an export invoice?",
    ]
  : [
      "How do I add the tracking script to my site?",
      "Can I exclude my own visits from the stats?",
      "How do I set up a custom event goal?",
    ];

export function AskPage() {
  // The conversation lives above the routes (see conversation.tsx), so it is
  // still here after visiting another page, and reloads from the server.
  const {
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
  } = useConversation();
  const { sourceId, label: sourceLabel, scopes } = useScope();
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Only once there is a conversation: scrolling the empty state would hide its heading.
    if (messages.length === 0 && !pending) return;
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending, failed]);

  function submit(text: string) {
    if (!text.trim() || pending || loading) return;
    setDraft("");
    send(text, sourceId);
  }

  const empty = messages.length === 0 && !pending && !loading && !historyError;

  return (
    <PageContainer>
      <PageHeader
        centered
        title="Ask KnowledgePulse"
        description={
          sourceId
            ? `Answering from ${sourceLabel} only. Other indexed sources are excluded.`
            : "Ask a question about your connected knowledge."
        }
        actions={scopes.length > 1 ? <SourceFilter /> : undefined}
      />

      <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        {/* Past conversations. Starting a new one used to leave the old one
            unreachable: the turns stayed in the database but nothing listed
            them. This is that list. */}
        <Panel className="hidden h-[calc(100vh-20rem)] min-h-[26rem] flex-col lg:flex">
          <div className="flex items-center justify-between gap-2 border-b border-rule px-4 py-2.5">
            <p className="text-small font-medium">Conversations</p>
            <button
              onClick={() => {
                setDraft("");
                startNew();
              }}
              disabled={pending}
              title="Start a new conversation"
              aria-label="Start a new conversation"
              className="grid h-7 w-7 place-items-center rounded text-ink-soft transition-colors hover:bg-paper-sunk hover:text-ink disabled:opacity-40"
            >
              <MessageSquarePlus size={15} aria-hidden />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {conversationsLoading && conversations.length === 0 ? (
              <div className="space-y-2 p-1">
                {[0, 1, 2].map((n) => (
                  <Skeleton key={n} className="h-12 w-full" />
                ))}
              </div>
            ) : conversations.length === 0 ? (
              <p className="px-2 py-3 text-micro text-ink-faint">
                Your conversations will be listed here once you have asked something.
              </p>
            ) : (
              <ul className="space-y-0.5">
                {conversations.map((c) => {
                  const active = c.sessionId === sessionId;
                  return (
                    <li key={c.sessionId}>
                      <button
                        onClick={() => open(c.sessionId)}
                        aria-current={active ? "true" : undefined}
                        className={clsx(
                          "w-full rounded px-2.5 py-2 text-left transition-colors",
                          active ? "bg-paper-sunk" : "hover:bg-paper-sunk/60",
                        )}
                      >
                        <span
                          className={clsx(
                            "line-clamp-2 text-small",
                            active ? "font-medium text-ink" : "text-ink-soft",
                          )}
                        >
                          {c.title}
                        </span>
                        <span className="mt-0.5 block text-micro text-ink-faint">
                          {relativeTime(c.lastMessageAt)} · {c.turnCount} turns
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Panel>

        <Panel className="flex h-[calc(100vh-20rem)] min-h-[26rem] flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-rule px-5 py-2.5">
            <p className="text-small font-medium">
              Assistant
              {sourceId && <span className="ml-2 font-normal text-ink-faint">{sourceLabel}</span>}
            </p>
            <Button
              variant="quiet"
              onClick={() => {
                setDraft("");
                startNew();
              }}
              disabled={pending || (messages.length === 0 && !failed)}
              className="px-3 py-1.5"
            >
              <MessageSquarePlus size={14} aria-hidden />
              New conversation
            </Button>
          </div>

          <div ref={scroller} className="flex-1 overflow-y-auto px-5 py-6" aria-live="polite">
            {loading ? (
              <p role="status" className="py-10 text-center text-small text-ink-faint">
                Loading this conversation
              </p>
            ) : historyError ? (
              <ChatError message={`Could not load this conversation. ${historyError}`} onRetry={reload} />
            ) : empty ? (
              <ChatEmptyState examples={examples} onPick={submit} />
            ) : (
              <div className="space-y-6">
                {messages.map((m) =>
                  m.role === "customer" ? (
                    <UserMessageBubble key={m.id} text={m.text} />
                  ) : (
                    <AssistantMessageBubble key={m.id} message={m} />
                  ),
                )}
                {pending && <ChatLoadingBubble />}
                {failed && <ChatError message={failed.error} onRetry={retry} />}
              </div>
            )}
          </div>

          <div className="border-t border-rule p-3">
            <ChatComposer
              value={draft}
              onChange={setDraft}
              onSend={() => submit(draft)}
              disabled={pending || loading}
            />
            <p className="mt-2 px-1 text-micro text-ink-faint">
              Enter to send, Shift and Enter for a new line. Every question is logged for the
              period's analytics, and earlier conversations stay in the list beside this one.
            </p>
          </div>
        </Panel>
      </div>
    </PageContainer>
  );
}
