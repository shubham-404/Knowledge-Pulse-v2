import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { Layers } from "lucide-react";
import { api, getWorkspaceId, getSession } from "@/lib/api";
import type { Period, Scope } from "@/lib/types";
import { inputClass } from "@/components/ui";

// One workspace can hold several documentation sites. The scope is which of
// them you are currently looking at, and it is deliberately shared across
// Overview, Insights, Report and Ask rather than being a per-page dropdown:
// picking "FastAPI docs" on Insights and then opening Report should not silently
// put you back on the whole-workspace numbers.
//
// The choice is remembered per organisation and workspace, the same way the
// workspace itself is, so switching workspace does not carry a source id that
// belongs to a different one.

interface ScopeState {
  scopes: Scope[];
  /** null means every source in the workspace. */
  sourceId: string | null;
  label: string;
  select: (id: string | null) => void;
  loading: boolean;
  reload: () => void;
}

const ScopeContext = createContext<ScopeState | null>(null);

export function useScope() {
  const ctx = useContext(ScopeContext);
  if (!ctx) throw new Error("useScope must be used inside ScopeProvider");
  return ctx;
}

const storageKey = () =>
  `kp.scope.${getSession()?.user.organizationId ?? "none"}.${getWorkspaceId() || "default"}`;

function stored(): string | null {
  try {
    return localStorage.getItem(storageKey()) || null;
  } catch {
    return null;
  }
}

export function ScopeProvider({ children }: { children: ReactNode }) {
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [sourceId, setSourceId] = useState<string | null>(() => stored());
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .getScopes()
      .then((rows) => {
        if (!live) return;
        setScopes(rows);
        // A remembered source that has since been deleted would filter every
        // page down to nothing with no way to tell why. Fall back quietly.
        setSourceId((current) =>
          current && !rows.some((s) => s.sourceId === current) ? null : current,
        );
      })
      .catch(() => live && setScopes([]))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [tick]);

  const select = useCallback((id: string | null) => {
    setSourceId(id);
    try {
      if (id) localStorage.setItem(storageKey(), id);
      else localStorage.removeItem(storageKey());
    } catch {
      // Storage disabled: the choice lasts for this page load.
    }
  }, []);

  const label = useMemo(
    () => scopes.find((s) => s.sourceId === sourceId)?.label ?? "All sources",
    [scopes, sourceId],
  );

  const value: ScopeState = {
    scopes,
    sourceId,
    label,
    select,
    loading,
    reload: useCallback(() => setTick((t) => t + 1), []),
  };

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

/**
 * The site picker. Hidden when there is nothing to pick between: a workspace
 * with one indexed source does not need a filter that has one setting.
 */
export function SourceFilter({ compact = false }: { compact?: boolean }) {
  const { scopes, sourceId, select } = useScope();
  if (scopes.length < 2) return null;

  return (
    <label className="flex items-center gap-2 text-small text-ink-soft">
      {!compact && <Layers size={14} className="text-ink-faint" aria-hidden />}
      <span className={compact ? "sr-only" : "sr-only sm:not-sr-only"}>Source</span>
      <select
        value={sourceId ?? ""}
        onChange={(e) => select(e.target.value || null)}
        className={clsx(inputClass, "w-auto max-w-[14rem] py-2 pr-8 text-small")}
      >
        {scopes.map((s) => (
          <option key={s.sourceId ?? "all"} value={s.sourceId ?? ""}>
            {s.label}
            {s.questionCount ? ` (${s.questionCount.toLocaleString()})` : ""}
            {s.analysed ? "" : " — not analysed"}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The period picker. Every period that has logged questions appears, not only
 * the ones already clustered, and an unanalysed one says so instead of simply
 * being absent — which is what made July look like a month with no traffic.
 */
export function PeriodFilter({
  periods,
  value,
  onChange,
  allowAll = false,
}: {
  periods: Period[];
  value: string;
  onChange: (period: string) => void;
  allowAll?: boolean;
}) {
  if (!periods.length) return null;
  return (
    <label className="flex items-center gap-2 text-small text-ink-soft">
      <span className="sr-only">Period</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={clsx(inputClass, "w-auto py-2 pr-8 text-small")}
      >
        {allowAll && <option value="">Every period</option>}
        {periods.map((p) => (
          <option key={p.period} value={p.period}>
            {p.period}
            {p.analysed ? ` — ${p.topicCount} topics` : ` — ${p.queryCount} questions, not analysed`}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Shown when the selected period has questions but has never been clustered.
 * The old interface gave no clue this state existed: the period simply did not
 * appear in the list, so there was nothing to click and nothing to explain.
 */
export function UnanalysedNotice({
  period,
  onRun,
  running,
}: {
  period: Period;
  onRun: () => void;
  running: boolean;
}) {
  if (period.analysed) return null;
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border-l-4 border-ochre bg-ochre-wash px-4 py-3 text-small text-[#7A5A17]">
      <p className="min-w-0 flex-1">
        <span className="font-medium">{period.period}</span> has{" "}
        {period.queryCount.toLocaleString()} logged questions but has never been clustered, so there
        are no topics to show for it yet.
      </p>
      <button
        onClick={onRun}
        disabled={running}
        className="font-medium underline underline-offset-4 disabled:opacity-50"
      >
        {running ? "Running analytics" : `Run analytics for ${period.period}`}
      </button>
    </div>
  );
}
