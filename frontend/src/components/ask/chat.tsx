import { useEffect, useRef, type KeyboardEvent } from "react";
import clsx from "clsx";
import { ArrowUp, RotateCcw } from "lucide-react";
import type { Citation, Message } from "@/lib/types";
import { pct, WEAK_CONFIDENCE } from "@/lib/format";

export function ChatEmptyState({ examples, onPick }: { examples: string[]; onPick: (q: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-10 text-center">
      <p className="font-display text-h3 font-semibold">What do you need help with?</p>
      <p className="mt-2 max-w-sm text-small text-ink-soft">
        Answers come only from your connected sources, with the passages they came from.
      </p>
      <div className="mt-6 flex w-full max-w-md flex-col gap-2">
        {examples.map((q) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="rounded border border-rule-strong bg-paper px-4 py-2.5 text-left text-small text-ink-soft transition-colors hover:border-oxblood hover:text-ink"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

export function UserMessageBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-md rounded-br-sm bg-paper-sunk px-4 py-2.5 text-base text-ink">
        {text}
      </p>
    </div>
  );
}

export function ConfidenceMeter({ value }: { value: number }) {
  const weak = value < WEAK_CONFIDENCE;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-small text-ink-soft">Confidence</span>
      <div
        className="h-1.5 w-28 overflow-hidden rounded-full bg-paper-sunk"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        aria-label="Retrieval confidence"
      >
        <div className={clsx("h-full", weak ? "bg-oxblood" : "bg-olive")} style={{ width: `${value * 100}%` }} />
      </div>
      <span className={clsx("tabular text-small font-medium", weak ? "text-oxblood" : "text-olive")}>{pct(value)}</span>
      {weak && <span className="text-micro text-ink-faint">The sources may not cover this</span>}
    </div>
  );
}

export function CitationItem({ citation: c }: { citation: Citation }) {
  return (
    <li className="rounded border border-rule bg-paper px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-small text-ink">
          {c.sourceLabel}
          <span className="text-ink-faint"> in {c.headingPath}</span>
        </p>
        <span className="tabular font-mono text-micro text-ink-faint">{c.similarity.toFixed(2)}</span>
      </div>
      <p className="mt-1 text-small text-ink-soft">“{c.excerpt}”</p>
    </li>
  );
}

/**
 * Retrieval already collapses passages that are the same material, so this is a
 * safety net rather than the fix: an archived turn answered before that landed
 * can still carry several copies of one section at different similarities, and
 * five copies of one paragraph is not five pieces of evidence. Keeping the
 * best-scoring copy of each section matches what a fresh answer would show.
 */
function distinct(citations: Citation[]): Citation[] {
  const best = new Map<string, Citation>();
  for (const c of citations) {
    const key = `${c.sourceLabel}\u241F${c.headingPath}`;
    const seen = best.get(key);
    if (!seen || c.similarity > seen.similarity) best.set(key, c);
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity);
}

export function CitationList({ citations }: { citations: Citation[] }) {
  const shown = distinct(citations);
  const collapsed = citations.length - shown.length;

  return (
    <div>
      <p className="mb-2 text-small text-ink-soft">
        Sources
        {collapsed > 0 && (
          <span className="ml-2 text-micro text-ink-faint">
            {collapsed} repeated {collapsed === 1 ? "passage" : "passages"} merged
          </span>
        )}
      </p>
      <ul className="space-y-2">
        {shown.map((c) => (
          <CitationItem key={c.chunkId} citation={c} />
        ))}
      </ul>
    </div>
  );
}

export function AssistantMessageBubble({ message }: { message: Message }) {
  return (
    <div className="max-w-[92%] space-y-4">
      <div>
        {message.text.split("\n\n").map((para, n) => (
          <p key={n} className="mb-3 text-base text-ink last:mb-0">
            {para}
          </p>
        ))}
      </div>
      {typeof message.confidence === "number" && <ConfidenceMeter value={message.confidence} />}
      {message.citations && message.citations.length > 0 && <CitationList citations={message.citations} />}
    </div>
  );
}

export function ChatLoadingBubble() {
  return (
    <div role="status" aria-label="The assistant is searching your sources" className="flex items-center gap-2 text-small text-ink-faint">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((n) => (
          <span
            key={n}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-faint"
            style={{ animationDelay: `${n * 140}ms` }}
          />
        ))}
      </span>
      Searching your sources
    </div>
  );
}

export function ChatError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded border-l-2 border-oxblood bg-oxblood-wash px-4 py-2.5 text-small text-oxblood-deep">
      <p className="min-w-0 flex-1">The assistant could not answer. {message}</p>
      <button onClick={onRetry} className="inline-flex items-center gap-1 font-medium underline underline-offset-4">
        <RotateCcw size={13} aria-hidden />
        Try again
      </button>
    </div>
  );
}

export function ChatComposer({
  value,
  onChange,
  onSend,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to about six lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="flex items-end gap-2 rounded-md border border-rule-strong bg-paper-raised p-2 focus-within:border-oxblood">
      <label htmlFor="chat-input" className="sr-only">
        Ask a question
      </label>
      <textarea
        id="chat-input"
        ref={ref}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        placeholder="Ask a question..."
        className="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent px-2 py-2 text-base placeholder:text-ink-faint focus:outline-none"
      />
      <button
        onClick={onSend}
        disabled={disabled || !value.trim()}
        aria-label="Send"
        className="grid h-10 w-10 shrink-0 place-items-center rounded bg-oxblood text-paper-raised transition-colors hover:bg-oxblood-deep disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ArrowUp size={18} />
      </button>
    </div>
  );
}
