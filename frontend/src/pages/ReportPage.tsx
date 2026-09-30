import { useEffect, useState } from "react";
import clsx from "clsx";
import { Download } from "lucide-react";
import { api } from "@/lib/api";
import { categoryCopy, useAsync } from "@/lib/format";
import type { ActionCategory } from "@/lib/types";
import {
  Button,
  EmptyState,
  ErrorState,
  MetricSkeletons,
  PageContainer,
  PageHeader,
  RefreshButton,
  RowSkeletons,
  Skeleton,
} from "@/components/ui";
import {
  LatestReportCard,
  RecommendationsSection,
  ReportHistory,
  ReportMetricGrid,
} from "@/components/report/parts";
import { PeriodFilter, SourceFilter, UnanalysedNotice, useScope } from "@/components/filters";
import { useToast } from "@/components/toast";

const categories: ActionCategory[] = ["product", "documentation", "faq", "customer_issue"];

export function ReportPage() {
  const { sourceId, label: sourceLabel } = useScope();
  const toast = useToast();

  const [period, setPeriod] = useState("");
  // Empty means every category. Filtering happens on the server so the PDF and
  // the page cannot disagree about what was included.
  const [chosen, setChosen] = useState<ActionCategory[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [running, setRunning] = useState(false);

  const periods = useAsync(() => api.getPeriods({ source: sourceId }), [sourceId]);
  const filters = { source: sourceId, period: period || undefined, categories: chosen };
  const report = useAsync(() => api.getReport(filters), [sourceId, period, chosen.join(",")]);
  const history = useAsync(() => api.getReports({ source: sourceId }), [sourceId]);

  // Reset the period when the source changes: a period with a report on one
  // site may have none on another.
  useEffect(() => {
    const available = periods.data ?? [];
    if (period && !available.some((p) => p.period === period)) setPeriod("");
  }, [period, periods.data]);

  const selected = periods.data?.find((p) => p.period === period) ?? null;

  const refresh = () => {
    report.reload();
    history.reload();
    periods.reload();
  };

  function toggle(category: ActionCategory) {
    setChosen((current) =>
      current.includes(category) ? current.filter((c) => c !== category) : [...current, category],
    );
  }

  async function download() {
    setDownloading(true);
    try {
      const name = await api.downloadReportPdf({ ...filters, everyPeriod: !period });
      toast(`Downloaded ${name}`, "success");
    } catch (e) {
      toast(`Could not download the report. ${(e as Error).message}`, "error");
    } finally {
      setDownloading(false);
    }
  }

  async function runForPeriod() {
    if (!selected) return;
    setRunning(true);
    try {
      await api.runAnalytics({ period: selected.period, source: sourceId });
      toast(`Writing the ${selected.period} report for ${sourceLabel}. Refresh shortly.`, "success");
    } catch (e) {
      toast(`Could not start analytics. ${(e as Error).message}`, "error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Report"
        description={
          sourceId
            ? `The client report for ${sourceLabel}. Each recommendation names one action and shows the customer questions behind it.`
            : "The client report for the latest period. Each recommendation names one action and shows the customer questions behind it."
        }
        actions={
          <>
            <SourceFilter />
            <PeriodFilter
              periods={periods.data ?? []}
              value={period}
              onChange={setPeriod}
              allowAll
            />
            <RefreshButton onClick={refresh} loading={report.loading || history.loading} />
            <Button onClick={download} busy={downloading} disabled={!report.data}>
              {!downloading && <Download size={14} aria-hidden />}
              {downloading ? "Preparing PDF" : "Download PDF"}
            </Button>
          </>
        }
      />

      {selected && <UnanalysedNotice period={selected} onRun={runForPeriod} running={running} />}

      <div className="mb-8 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-small text-ink-faint">Show</span>
        <button
          onClick={() => setChosen([])}
          aria-pressed={chosen.length === 0}
          className={clsx(
            "rounded border px-3 py-1.5 text-small transition-colors",
            chosen.length === 0
              ? "border-oxblood bg-oxblood-wash text-oxblood-deep"
              : "border-rule-strong text-ink-soft hover:bg-paper-sunk",
          )}
        >
          All four
        </button>
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => toggle(c)}
            aria-pressed={chosen.includes(c)}
            title={categoryCopy[c].note}
            className={clsx(
              "rounded border px-3 py-1.5 text-small transition-colors",
              chosen.includes(c)
                ? "border-oxblood bg-oxblood-wash text-oxblood-deep"
                : "border-rule-strong text-ink-soft hover:bg-paper-sunk",
            )}
          >
            {categoryCopy[c].label}
          </button>
        ))}
        <span className="pl-1 text-micro text-ink-faint">
          The PDF carries whichever filters are set here.
        </span>
      </div>

      {!report.data && report.loading && (
        <div className="space-y-6">
          <Skeleton className="h-36 w-full" />
          <MetricSkeletons count={3} />
          <RowSkeletons rows={3} />
        </div>
      )}

      {report.error && !report.data && (
        <EmptyState
          title="No report for these filters"
          description={`${report.error} Reports are written by the analytics batch, once per period and once per source.`}
        />
      )}

      {report.data && (
        <div className="space-y-10">
          <LatestReportCard report={report.data} />
          <ReportMetricGrid report={report.data} />
          {report.data.recommendations.length > 0 ? (
            <RecommendationsSection recommendations={report.data.recommendations} />
          ) : (
            <EmptyState
              title={chosen.length ? "Nothing in the selected categories" : "No recommendations this period"}
              description={
                chosen.length
                  ? "This period produced recommendations, but none in the categories you have selected. Choose All four to see them."
                  : "Nothing stood out strongly enough to act on. That usually means the sources covered what customers asked."
              }
            />
          )}
        </div>
      )}

      <div className="mt-14">
        {history.data && history.data.length > 0 && (
          <ReportHistory reports={history.data} currentId={report.data?.id} />
        )}
        {history.error && report.data && (
          <ErrorState message={`Report history is unavailable. ${history.error}`} onRetry={history.reload} />
        )}
      </div>
    </PageContainer>
  );
}
