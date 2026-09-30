import { useEffect, useState } from "react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { trendCopy, useAsync } from "@/lib/format";
import type { TrendState } from "@/lib/types";
import { EmptyState, ErrorState, PageContainer, PageHeader, RefreshButton, RowSkeletons } from "@/components/ui";
import { InsightList } from "@/components/insights/InsightList";
import { PeriodFilter, SourceFilter, UnanalysedNotice, useScope } from "@/components/filters";
import { useToast } from "@/components/toast";

type Filter = "all" | TrendState;

const filters: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "emerging", label: "Emerging" },
  { key: "recurring", label: "Recurring" },
  { key: "stable", label: "Stable" },
];

export function InsightsPage() {
  const { sourceId, label: sourceLabel, scopes } = useScope();
  const toast = useToast();
  const periods = useAsync(() => api.getPeriods({ source: sourceId }), [sourceId]);
  const [period, setPeriod] = useState<string>("");
  const [filter, setFilter] = useState<Filter>("all");
  const [running, setRunning] = useState(false);
  const insights = useAsync(
    () => api.getInsights({ period: period || undefined, source: sourceId }),
    [period, sourceId],
  );

  // Default to the most recent period, and reset when the source changes: a
  // period that exists for one site may have no traffic at all on another.
  useEffect(() => {
    const available = periods.data ?? [];
    if (!available.length) return;
    if (!period || !available.some((p) => p.period === period)) setPeriod(available[0].period);
  }, [period, periods.data]);

  const selected = periods.data?.find((p) => p.period === period) ?? null;
  const shown = insights.data?.filter((i) => filter === "all" || i.trend === filter) ?? [];

  async function runForPeriod() {
    if (!selected) return;
    setRunning(true);
    try {
      await api.runAnalytics({ period: selected.period, source: sourceId });
      toast(
        `Clustering ${selected.period} for ${sourceLabel}. Refresh in a minute or two.`,
        "success",
      );
    } catch (e) {
      toast(`Could not start analytics. ${(e as Error).message}`, "error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Insights"
        description={
          sourceId
            ? `What customers asked about ${sourceLabel}, what is changing, and where that site's documentation appears weakest.`
            : "What customers are asking, what is changing, and where the knowledge base appears weakest."
        }
        actions={
          <>
            <SourceFilter />
            <PeriodFilter periods={periods.data ?? []} value={period} onChange={setPeriod} />
            <RefreshButton onClick={insights.reload} loading={insights.loading} />
          </>
        }
      />

      {selected && <UnanalysedNotice period={selected} onRun={runForPeriod} running={running} />}

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={clsx(
              "rounded border px-3 py-1.5 text-small transition-colors",
              filter === f.key
                ? "border-oxblood bg-oxblood-wash text-oxblood-deep"
                : "border-rule-strong text-ink-soft hover:bg-paper-sunk",
            )}
          >
            {f.label}
          </button>
        ))}
        {filter !== "all" && <span className="pl-1 text-micro text-ink-faint">{trendCopy[filter].note}</span>}
      </div>

      {insights.error && <ErrorState message={insights.error} onRetry={insights.reload} />}
      {!insights.data && !insights.error && <RowSkeletons rows={6} />}

      {insights.data && insights.data.length === 0 && (
        <EmptyState
          title="No topics for this period"
          description={
            scopes.length > 1 && sourceId
              ? `Nothing has been clustered for ${sourceLabel} in this period. Each site is clustered separately, so a site needs its own analytics run.`
              : "Topics appear after the analytics batch has clustered the period's questions. Run analytics from This period, then refresh."
          }
        />
      )}

      {insights.data && insights.data.length > 0 && shown.length === 0 && (
        <EmptyState title={`No ${filter} topics this period`} description="Try another filter or period." />
      )}

      {shown.length > 0 && <InsightList insights={shown} />}

      <p className="mt-8 max-w-measure text-small text-ink-faint">
        Priority combines four signals: how many people asked, how fast that number is moving, how far retrieval
        confidence fell short, and how badly the topic blocks the customer. Default weights are 0.30, 0.30, 0.25 and
        0.15.
      </p>
    </PageContainer>
  );
}
