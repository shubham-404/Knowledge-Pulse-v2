import { useState } from "react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/format";
import {
  ChartSkeleton,
  EmptyState,
  PageContainer,
  PageHeader,
  RefreshButton,
  RowSkeletons,
  inputClass,
} from "@/components/ui";
import {
  ComparisonChart,
  MethodNote,
  MetricTable,
  RunMeta,
  SectionExplainer,
  SignificanceTable,
  SitesTable,
  TransferTable,
  gapColumns,
  qualityColumns,
  retrievalColumns,
} from "@/components/research/parts";

// Written for someone who has landed on this page without reading the paper.
// Each one says what the section is really asking and why the answer matters,
// before any number is read.
const explains = {
  retrieval:
    "Every question here has a known answer sitting somewhere in that site's own documentation. The experiment asks: with the docs cut up this particular way, does the search actually find it? Each row is one way of cutting the same pages — by fixed word count, by paragraph, or at the headings — so any difference in these columns comes from the cutting alone, never from different content or a different search. That is the point the whole paper turns on: chunking is usually treated as plumbing, and it is not.",
  gap:
    "The same questions, plus a set the site genuinely cannot answer, borrowed from the other sites in the run. This section asks whether the system can tell the two apart from retrieval confidence alone, before any answer is written. It matters because the entire insights layer rests on it: when KnowledgePulse tells a client their documentation has a hole, the evidence is that confidence stayed low on a topic. If confidence cannot separate 'we do not document this' from 'we do', then every knowledge gap the product reports is guesswork.",
  quality:
    "These numbers are about the chunks themselves and involve no questions at all — you could compute them before anyone asks anything. They describe what each chunker did to the documentation: how big the pieces are, how even, how many are scraps too short to be useful, how often a piece runs across a heading and ends up half about one topic and half about another, and how often a code example gets cut in two. A chunker can look respectable in the retrieval table while quietly mangling the corpus, and this is where that shows.",
  significance:
    "A chunker can win a column by luck. These questions are a sample, and a different hundred questions would give slightly different numbers, so a small lead may be noise. Each comparison is re-run two thousand times on resampled versions of the same questions to see how much the difference moves about. When the resulting range of plausible differences excludes zero, the lead survived the shuffling and is real; when it straddles zero, the two chunkers cannot be told apart on this evidence and the honest answer is 'no clear difference'. Most rows here say exactly that, which is itself a finding.",
  transfer:
    "The confidence threshold that best separates answered from unanswered is tuned on one site, then applied unchanged to a different one. If the borrowed setting does nearly as well as that site's own best, one default can ship to a new organisation and work on day one, with no tuning and no labelled data from them. If it collapses, every deployment needs its own calibration, and the product needs a setup step it currently does not have.",
};

const commands = [
  "python -m research.snapshot --site plausible",
  "python -m research.questions --site plausible --count 100",
  "python -m research.run --sites plausible,fastapi",
];

export function ResearchPage() {
  const { data, error, loading, reload } = useAsync(() => api.getResearch(), []);
  const [size, setSize] = useState<number | null>(null);

  const sizes = data?.sizes ?? [];
  const activeSize = size ?? sizes[0] ?? null;
  const results = data?.results.filter((r) => activeSize == null || r.size === activeSize) ?? [];
  const comparisons = data?.comparisons.filter((c) => activeSize == null || c.config.endsWith(`@${activeSize}`)) ?? [];
  const transfer = data?.transfer.filter((t) => activeSize == null || t.config.endsWith(`@${activeSize}`)) ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Research"
        description="How the way documentation is chunked changes what the assistant retrieves, and how reliably it spots gaps in the docs."
        meta={data && <RunMeta run={data} />}
        actions={
          <>
            {sizes.length > 1 && (
              <label className="flex items-center gap-2 text-small text-ink-soft">
                Chunk size
                <select
                  value={activeSize ?? ""}
                  onChange={(e) => setSize(Number(e.target.value))}
                  className={clsx(inputClass, "w-auto py-2 pr-8 text-small")}
                >
                  {sizes.map((s) => (
                    <option key={s} value={s}>
                      {s} words
                    </option>
                  ))}
                </select>
              </label>
            )}
            <RefreshButton onClick={reload} loading={loading} />
          </>
        }
      />

      {loading && !data && (
        <div className="space-y-6">
          <RowSkeletons rows={3} />
          <ChartSkeleton height="h-72" />
        </div>
      )}

      {error && !data && (
        <EmptyState
          title="No experiment results yet"
          description="Run these from the backend folder, in order. The last one writes the results this page reads."
          action={
            <pre className="overflow-x-auto rounded border border-rule-strong bg-paper-raised px-4 py-3 text-left font-mono text-small text-ink">
              {commands.join("\n")}
            </pre>
          }
        />
      )}

      {data?.run_id === "placeholder" && (
        <p className="mb-8 rounded-md border-l-4 border-ochre bg-ochre-wash px-4 py-3 text-small text-[#7A5A17]">
          These numbers are invented placeholders so the layout can be reviewed. Do not cite them. Connect the backend and
          run the experiment for real results.
        </p>
      )}

      {data && (
        <div className="space-y-12">
          <SitesTable run={data} />
          <ComparisonChart results={results} k={data.k} />

          <div>
            <MetricTable
              title="Retrieval"
              description="On questions each site's own documentation answers. The best value per site is marked."
              results={results}
              columns={retrievalColumns(data.k)}
            />
            <SectionExplainer plain={explains.retrieval} />
          </div>

          <div>
            <MetricTable
              title="Knowledge-gap signal"
              description="Retrieval confidence on answerable versus unanswerable questions. This is the signal the insights layer ranks topics by."
              results={results}
              columns={gapColumns}
            />
            <SectionExplainer plain={explains.gap} />
          </div>

          <div>
            <MetricTable
              title="Chunk quality"
              description="Properties of the chunks themselves, measured without any questions."
              results={results}
              columns={qualityColumns}
            />
            <SectionExplainer plain={explains.quality} />
          </div>

          <div>
            <SignificanceTable run={{ ...data, comparisons }} />
            {comparisons.length > 0 && <SectionExplainer plain={explains.significance} />}
          </div>

          <div>
            <TransferTable run={{ ...data, transfer }} />
            {transfer.length > 0 && <SectionExplainer plain={explains.transfer} />}
          </div>
          <MethodNote run={data} />
        </div>
      )}
    </PageContainer>
  );
}
