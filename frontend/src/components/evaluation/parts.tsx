import clsx from "clsx";
import type { EvaluationRun } from "@/lib/types";
import { dateLabel, pct } from "@/lib/format";
import { Panel, SectionHeader } from "@/components/ui";

export const metrics = [
  {
    key: "faithfulness" as const,
    label: "Faithfulness",
    plain: "Does the answer stay inside what the retrieved passages actually said?",
    target: 0.8,
    how:
      "The judge splits the answer into its separate factual claims, then counts how many of " +
      "them the passages actually support. The score is supported ÷ total. An answer that " +
      "correctly says it could not find something makes no claim, so it is faithful by default.",
  },
  {
    key: "answerRelevance" as const,
    label: "Answer relevance",
    plain: "Does the answer address the question that was asked?",
    target: 0.8,
    how:
      "The model is asked to write the questions this answer would be a good answer to. Those " +
      "questions and the real one are turned into vectors by the local embedding model, and the " +
      "score is how close they sit. No judge scores this one, so it cannot drift between runs.",
  },
  {
    key: "contextRelevance" as const,
    label: "Context relevance",
    plain: "Were the retrieved passages the right ones to pull?",
    target: 0.8,
    how:
      "The judge is shown the question and the numbered passages retrieval returned, and lists " +
      "which of them help answer it. The score is relevant ÷ retrieved. This is about the " +
      "retriever, not the writer: it can be low while faithfulness is high.",
  },
];

export function MetricProgress({ score, target }: { score: number; target: number }) {
  const met = score >= target;
  return (
    <div>
      <div className="relative h-2 rounded-full bg-paper-sunk">
        <div
          className={clsx("h-full rounded-full", met ? "bg-olive" : "bg-oxblood")}
          style={{ width: `${Math.min(100, score * 100)}%` }}
        />
        <div
          className="absolute -top-1 h-4 w-0.5 bg-ink"
          style={{ left: `${target * 100}%` }}
          title={`Target ${pct(target)}`}
          aria-hidden
        />
      </div>
      <p className="mt-1.5 text-micro text-ink-faint">Target {pct(target)}</p>
    </div>
  );
}

export function EvaluationMetricCard({
  label,
  plain,
  score,
  target,
}: {
  label: string;
  plain: string;
  score: number;
  target: number;
}) {
  const met = score >= target;
  return (
    <Panel className="flex flex-col p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lead font-semibold">{label}</h2>
        <span className={clsx("text-micro font-medium", met ? "text-olive" : "text-oxblood")}>
          {met ? "Meets target" : "Below target"}
        </span>
      </div>
      <p className={clsx("tabular mt-3 font-display text-h1 font-semibold", met ? "text-olive" : "text-oxblood")}>
        {score.toFixed(2)}
      </p>
      <p className="mt-1 flex-1 text-small text-ink-soft">{plain}</p>
      <div className="mt-4">
        <MetricProgress score={score} target={target} />
      </div>
    </Panel>
  );
}

export function EvaluationMetricGrid({ run }: { run: EvaluationRun }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {metrics.map((m) => (
        <EvaluationMetricCard
          key={m.key}
          label={m.label}
          plain={m.plain}
          score={run[m.key]}
          // The backend owns the targets, so the page and NFR4 cannot drift apart.
          target={run.targets?.[m.key] ?? m.target}
        />
      ))}
    </div>
  );
}

/**
 * Questions the judge could not be reached for. These used to be scored zero and
 * averaged in with the real results, which made a rate-limited run look like a
 * broken assistant. They are now dropped and counted, and the count is shown
 * here because a run built on twelve of fifty questions is a weaker claim than
 * one built on fifty, even when the scores are identical.
 */
export function SampleNotice({ run }: { run: EvaluationRun }) {
  const skipped = run.skippedCount ?? 0;
  if (!skipped) return null;
  const attempted = run.questionCount + skipped;
  const thin = skipped > run.questionCount;

  return (
    <div
      className={clsx(
        "rounded-md border-l-4 px-4 py-3 text-small",
        thin ? "border-oxblood bg-oxblood-wash text-oxblood-deep" : "border-ochre bg-ochre-wash text-[#7A5A17]",
      )}
    >
      <p>
        <span className="tabular font-medium">{skipped}</span> of {attempted} questions were dropped
        because the evaluating model could not be reached, usually an API rate limit. They are not
        counted as failures: the scores above are the mean over the{" "}
        <span className="tabular font-medium">{run.questionCount}</span> that completed.
      </p>
      {thin && (
        <p className="mt-1">
          More were dropped than scored. The numbers are real but the sample is thin — re-run when
          the quota has recovered before quoting them.
        </p>
      )}
    </div>
  );
}

/** How the scoring works, in the words a non-specialist reader needs. */
export function HowScoringWorks({ run }: { run: EvaluationRun }) {
  return (
    <section>
      <SectionHeader
        title="How this is measured"
        description="Reference-free: nobody wrote model answers to compare against, so the suite can be re-run after every change to the sources at no cost beyond the API calls."
      />
      <Panel className="p-5">
        <ol className="space-y-3 text-small text-ink-soft">
          <li className="flex gap-3">
            <span className="tabular shrink-0 font-medium text-ink">1</span>
            <span>
              Each held-out question is put through the real assistant: the same retrieval, the same
              deduplication, the same prompt. Nothing is simulated.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="tabular shrink-0 font-medium text-ink">2</span>
            <span>
              A second model, acting as judge, is asked to <em>count</em> rather than to score —
              how many claims, how many supported, which passages helped. Counting is a far steadier
              thing to ask a model for than a mark out of ten, and it is checkable by hand.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="tabular shrink-0 font-medium text-ink">3</span>
            <span>
              Each metric is a ratio of those counts, averaged over every question that completed.
              A question the judge could not be reached for is dropped, never scored zero.
            </span>
          </li>
        </ol>

        <dl className="mt-6 space-y-4 border-t border-rule pt-5">
          {metrics.map((m) => (
            <div key={m.key}>
              <dt className="text-small font-medium text-ink">
                {m.label}
                <span className="tabular ml-2 font-normal text-ink-faint">
                  target {pct(run.targets?.[m.key] ?? m.target)}
                </span>
              </dt>
              <dd className="mt-1 max-w-measure text-small text-ink-soft">{m.how}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-6 max-w-measure border-t border-rule pt-4 text-micro text-ink-faint">
          The definitions follow the RAGAS paper (Es et al., EACL 2024), implemented directly rather
          than through the package, so the three metrics are the only dependency they bring.
          Faithfulness is the one NFR4 commits to.
        </p>
      </Panel>
    </section>
  );
}

export function EvaluationMetadata({ run }: { run: EvaluationRun }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 text-small text-ink-soft">
      <span>
        <span className="tabular font-medium text-ink">{run.questionCount}</span> questions evaluated
      </span>
      <span>Run on {dateLabel(run.ranAt)}</span>
    </div>
  );
}

const metricName: Record<string, string> = {
  faithfulness: "Faithfulness",
  answer_relevance: "Answer relevance",
  context_relevance: "Context relevance",
};

export function FailureCard({ failure }: { failure: EvaluationRun["failures"][number] }) {
  return (
    <li className="flex items-baseline gap-4 border-b border-rule px-4 py-3 last:border-b-0">
      <span className="tabular w-10 shrink-0 font-mono text-small text-oxblood">{failure.score.toFixed(2)}</span>
      <span className="min-w-0 flex-1 text-base">{failure.question}</span>
      <span className="hidden shrink-0 text-micro text-ink-faint sm:block">
        {metricName[failure.metric] ?? failure.metric.replace(/_/g, " ")}
      </span>
    </li>
  );
}

export function EvaluationFailures({ failures }: { failures: EvaluationRun["failures"] }) {
  return (
    <section>
      <SectionHeader
        title="Where it fell down"
        description="The lowest-scoring questions in this run. They usually line up with the topics Insights already flags."
      />
      <Panel>
        <ul>
          {failures.map((f, n) => (
            <FailureCard key={n} failure={f} />
          ))}
        </ul>
      </Panel>
    </section>
  );
}
