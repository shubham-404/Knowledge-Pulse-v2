import { api } from "@/lib/api";
import { useAsync } from "@/lib/format";
import { EmptyState, MetricSkeletons, PageContainer, PageHeader, RefreshButton, RowSkeletons } from "@/components/ui";
import {
  EvaluationFailures,
  EvaluationMetadata,
  EvaluationMetricGrid,
  HowScoringWorks,
  SampleNotice,
} from "@/components/evaluation/parts";

export function EvaluationPage() {
  const { data, error, loading, reload } = useAsync(() => api.getEvaluation(), []);

  return (
    <PageContainer>
      <PageHeader
        title="Evaluation"
        description="How well the assistant answers, scored on a held-out question set without human-written answers, so it can be re-run after any change to the sources."
        meta={data && <EvaluationMetadata run={data} />}
        actions={<RefreshButton onClick={reload} loading={loading} />}
      />

      {loading && !data && (
        <div className="space-y-6">
          <MetricSkeletons count={3} />
          <RowSkeletons rows={3} />
        </div>
      )}

      {error && !data && (
        <EmptyState
          title="No evaluation run yet"
          description={`${error} Run the evaluation harness on the backend, then refresh this page.`}
        />
      )}

      {data && (
        <div className="space-y-10">
          <EvaluationMetricGrid run={data} />
          <SampleNotice run={data} />
          {data.failures.length > 0 && <EvaluationFailures failures={data.failures} />}
          <HowScoringWorks run={data} />
        </div>
      )}
    </PageContainer>
  );
}
