import { Link } from "react-router-dom";
import type { ActionCategory, Recommendation, Report, ReportSummary } from "@/lib/types";
import { categoryCopy, dateLabel, growthLabel, pct } from "@/lib/format";
import { MetricCard, MetricGrid, Panel, SectionHeader, StatusBadge, type Tone } from "@/components/ui";

const categoryTone: Record<ActionCategory, Tone> = {
  product: "oxblood",
  documentation: "ochre",
  faq: "olive",
  customer_issue: "ink",
};

const order: ActionCategory[] = ["product", "documentation", "faq", "customer_issue"];

export function LatestReportCard({ report }: { report: Report }) {
  return (
    <Panel className="p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-h2 font-semibold tracking-tight">
          {report.period}
          {report.sourceLabel && (
            <span className="ml-3 align-middle text-small font-normal text-ink-faint">
              {report.sourceLabel}
            </span>
          )}
        </h2>
        <span className="text-small text-ink-faint">Generated {dateLabel(report.generatedAt)}</span>
      </div>
      <p className="mt-3 max-w-measure text-lead text-ink-soft">{report.summary}</p>
    </Panel>
  );
}

export function ReportMetricGrid({ report }: { report: Report }) {
  return (
    <MetricGrid>
      <MetricCard label="Conversations" value={report.conversationCount.toLocaleString()} />
      <MetricCard label="Questions" value={report.queryCount.toLocaleString()} />
      <MetricCard label="Unanswered rate" value={pct(report.unansweredRate, 1)} tone="oxblood" />
    </MetricGrid>
  );
}

export function RecommendationCard({ rec }: { rec: Recommendation }) {
  return (
    <Panel className="p-5">
      <StatusBadge tone={categoryTone[rec.category]}>{categoryCopy[rec.category].label}</StatusBadge>
      <h3 className="mt-3 text-h3 font-semibold">{rec.headline}</h3>
      <p className="mt-2 max-w-measure text-ink-soft">{rec.body}</p>

      {rec.faqAnswer && (
        <div className="mt-4 rounded border-l-2 border-olive bg-olive-wash/60 px-4 py-3">
          <p className="text-micro text-ink-faint">Draft answer, ready to publish</p>
          <p className="mt-1 text-base">{rec.faqAnswer}</p>
        </div>
      )}

      <p className="mt-4 text-small">
        <span className="text-ink-faint">If you do this: </span>
        <span className="text-ink">{rec.expectedEffect}</span>
      </p>

      <details className="group mt-4">
        <summary className="cursor-pointer list-none text-small text-oxblood underline underline-offset-4">
          <span className="group-open:hidden">Show the {rec.supportingQueries.length} customer questions behind this</span>
          <span className="hidden group-open:inline">Hide the questions</span>
        </summary>
        <ul className="mt-3 space-y-1.5 border-l border-rule-strong pl-4">
          {rec.supportingQueries.map((q, n) => (
            <li key={n} className="text-small text-ink-soft">
              {q}
            </li>
          ))}
        </ul>
      </details>

      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 border-t border-rule pt-3 text-micro text-ink-faint">
        <span className="tabular">{rec.volume} questions</span>
        <span className="tabular">{growthLabel(rec.growth)} vs last period</span>
        <Link to={`/insights/${rec.insightId}`} className="underline underline-offset-2 hover:text-oxblood">
          Topic: {rec.insightName}
        </Link>
      </div>
    </Panel>
  );
}

export function RecommendationsSection({ recommendations }: { recommendations: Recommendation[] }) {
  const groups = order
    .map((c) => ({ category: c, items: recommendations.filter((r) => r.category === c) }))
    .filter((g) => g.items.length > 0);

  return (
    <section className="space-y-10">
      {groups.map((g) => (
        <div key={g.category}>
          <SectionHeader title={categoryCopy[g.category].label} description={categoryCopy[g.category].note} />
          <div className="space-y-4">
            {g.items.map((r) => (
              <RecommendationCard key={r.id} rec={r} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

export function ReportHistory({ reports, currentId }: { reports: ReportSummary[]; currentId?: string }) {
  return (
    <section>
      <SectionHeader
        title="Earlier reports"
        description="One report per reporting period, and one per indexed source within it."
      />
      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[48rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-rule-strong text-micro font-medium text-ink-faint">
              <th scope="col" className="px-4 py-3">Period</th>
              <th scope="col" className="px-4 py-3">Source</th>
              <th scope="col" className="px-4 py-3">Generated</th>
              <th scope="col" className="px-4 py-3 text-right">Conversations</th>
              <th scope="col" className="px-4 py-3 text-right">Questions</th>
              <th scope="col" className="px-4 py-3 text-right">Unanswered</th>
              <th scope="col" className="px-4 py-3">Summary</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.id} className="border-b border-rule align-top last:border-b-0">
                <td className="whitespace-nowrap px-4 py-3 text-small font-medium">
                  {r.period}
                  {r.id === currentId && <span className="ml-2 text-micro font-normal text-ink-faint">latest</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-small text-ink-soft">
                  {r.sourceLabel ?? "All sources"}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-small text-ink-soft">{dateLabel(r.generatedAt)}</td>
                <td className="tabular px-4 py-3 text-right text-small">{r.conversationCount.toLocaleString()}</td>
                <td className="tabular px-4 py-3 text-right text-small">{r.queryCount.toLocaleString()}</td>
                <td className="tabular px-4 py-3 text-right text-small">{pct(r.unansweredRate, 1)}</td>
                <td className="max-w-md px-4 py-3 text-small text-ink-soft">
                  <p className="line-clamp-2">{r.summary}</p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </section>
  );
}
