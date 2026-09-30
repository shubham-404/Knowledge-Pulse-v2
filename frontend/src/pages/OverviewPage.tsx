import { useState } from "react";
import { Play } from "lucide-react";
import { api } from "@/lib/api";
import { pct, useAsync } from "@/lib/format";
import {
  Button,
  ChartSkeleton,
  EmptyState,
  ErrorState,
  MetricCard,
  MetricGrid,
  MetricSkeletons,
  PageContainer,
  PageHeader,
  RefreshButton,
} from "@/components/ui";
import { useToast } from "@/components/toast";
import { ConfidenceChart, QuestionVolumeChart } from "@/components/overview/charts";
import { AtAGlance } from "@/components/overview/AtAGlance";
import { SourceFilter, useScope } from "@/components/filters";

export function OverviewPage() {
  const { sourceId, label: sourceLabel, reload: reloadScopes } = useScope();
  const overview = useAsync(() => api.getOverview({ source: sourceId }), [sourceId]);
  const insights = useAsync(() => api.getInsights({ source: sourceId }), [sourceId]);
  const toast = useToast();
  const [running, setRunning] = useState(false);

  const refreshing = overview.loading || insights.loading;
  const refresh = () => {
    overview.reload();
    insights.reload();
  };

  async function runAnalytics() {
    setRunning(true);
    try {
      // No period and no source: every period, for the workspace as a whole and
      // once per indexed site, so the per-site pages fill in too.
      await api.runAnalytics();
      toast(
        "Analytics started for every period and every source. Topics and reports will update when the batch finishes.",
        "success",
      );
      reloadScopes();
      refresh();
    } catch (e) {
      toast(`Could not start analytics. ${(e as Error).message}`, "error");
    } finally {
      setRunning(false);
    }
  }

  const o = overview.data;

  return (
    <PageContainer>
      <PageHeader
        centered
        title="This period"
        description={
          o
            ? `Customer conversation and knowledge health for ${o.period}${
                o.sourceLabel ? `, across ${o.sourceLabel} only` : ""
              }.`
            : "Customer conversation and knowledge health for the current period."
        }
        actions={
          <>
            <SourceFilter />
            <RefreshButton onClick={refresh} loading={refreshing} />
            <Button onClick={runAnalytics} busy={running}>
              {!running && <Play size={14} aria-hidden />}
              {running ? "Running analytics" : "Run analytics"}
            </Button>
          </>
        }
      />

      {overview.error && !o && <ErrorState message={overview.error} onRetry={overview.reload} />}

      {!o && !overview.error && (
        <div className="space-y-6">
          <MetricSkeletons count={6} />
          <ChartSkeleton />
          <ChartSkeleton />
        </div>
      )}

      {o && o.queryCount === 0 && (
        <EmptyState
          title="No conversations yet"
          description={
            sourceId
              ? `Nothing has been asked that was answered from ${sourceLabel} yet. Pick another source, or choose All sources to see the whole workspace.`
              : "Once customers start asking the assistant questions, this page shows what they asked and how well your sources answered."
          }
          action={<Button onClick={runAnalytics} busy={running}>Run analytics</Button>}
        />
      )}

      {o && o.queryCount > 0 && (
        <div className="space-y-6">
          <MetricGrid>
            <MetricCard label="Conversations" value={o.conversationCount.toLocaleString()} note="Distinct chat sessions" />
            <MetricCard label="Questions" value={o.queryCount.toLocaleString()} note="Customer turns logged" />
            <MetricCard label="Topics" value={String(o.topicCount)} note="Found by clustering the questions" />
            <MetricCard
              label="Unanswered"
              value={pct(o.unansweredRate, 1)}
              note="Retrieval confidence below 40%"
              tone="oxblood"
            />
            <MetricCard
              label="Confidence"
              value={pct(o.meanConfidence)}
              note="Mean across every answer"
              tone={o.meanConfidence < 0.5 ? "oxblood" : "olive"}
            />
            <MetricCard label="Emerging" value={String(o.emergingCount)} note="New or rising sharply" tone="ochre" />
          </MetricGrid>

          <QuestionVolumeChart data={o.volumeByPeriod} />
          <ConfidenceChart data={o.volumeByPeriod} />

          {insights.data ? (
            <div className="pt-4">
              <AtAGlance overview={o} insights={insights.data} />
            </div>
          ) : insights.error ? (
            <ErrorState message={insights.error} onRetry={insights.reload} />
          ) : (
            <MetricSkeletons count={3} />
          )}
        </div>
      )}
    </PageContainer>
  );
}
