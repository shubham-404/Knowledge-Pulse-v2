import { useMemo, useState } from "react";
import clsx from "clsx";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ResearchResult, ResearchSummary } from "@/lib/types";
import { axisTick, palette, tooltipStyle } from "@/lib/chart";
import { dateLabel, pct } from "@/lib/format";
import { Panel, SectionHeader } from "@/components/ui";

export const chunkerCopy: Record<string, { label: string; note: string; colour: string }> = {
  fixed: { label: "Fixed window", note: "Word windows with overlap, ignoring structure", colour: palette.inkFaint },
  recursive: { label: "Recursive", note: "Whole paragraphs, then sentences, up to the size", colour: palette.ochre },
  heading: { label: "Heading-aware", note: "Cut at headings; window only long sections", colour: palette.olive },
  heading_ctx: { label: "Heading + path", note: "Heading-aware, with the heading path embedded", colour: palette.oxblood },
};

/**
 * What every metric on this page means, twice: once in the language of the
 * field, once in the language of someone who has not read the papers. Visitors
 * arrive at a table of numbers with no way in, and "MRR 0.572" tells them
 * nothing on its own.
 *
 * Keyed by the column key used in the tables below, so a column and its
 * definition cannot drift apart.
 */
export const glossary: Record<string, { term: string; technical: string; plain: string }> = {
  chunks: {
    term: "Chunks",
    technical: "Number of retrievable units the chunker produced from the frozen page snapshot.",
    plain:
      "How many pieces the documentation was cut into. Smaller pieces mean more of them, and more chances to match a question — but each piece carries less context around the answer.",
  },
  hit1: {
    term: "Hit@1",
    technical: "Fraction of questions whose top-ranked chunk is relevant to the gold passage.",
    plain:
      "How often the very first result was the right one. This is what matters if you only ever read the top answer.",
  },
  hitk: {
    term: "Hit@5",
    technical: "Fraction of questions with at least one relevant chunk in the top 5 retrieved.",
    plain:
      "How often the right material showed up anywhere in the five passages the assistant was given. The assistant reads all five, so this is closer to what it actually has to work with than Hit@1.",
  },
  mrr: {
    term: "MRR",
    technical:
      "Mean Reciprocal Rank: the average of 1/rank of the first relevant chunk, 0 when none is retrieved.",
    plain:
      "How near the top the right answer tends to land. First place scores 1, second scores 0.5, third 0.33, and nothing scores 0. One number that rewards being right and being early, so a chunker that buries the answer at rank five is separated from one that leads with it.",
  },
  recallk: {
    term: "Recall@5",
    technical:
      "Proportion of the gold passage covered by the union of the top 5 chunks, measured on overlapping word 3-grams.",
    plain:
      "How much of the real answer the five passages contain between them. This is the one that catches a chunker which sliced an answer in half: each half alone looks like a poor match, but together they cover the passage, and only Recall sees that.",
  },
  page: {
    term: "Page hit@5",
    technical: "Fraction of questions where at least one retrieved chunk comes from the gold page.",
    plain:
      "How often retrieval at least landed on the right page, even if it grabbed the wrong paragraph of it. A high page hit with a low Hit@5 means the search is finding the right topic and the chunker is cutting it badly.",
  },
  ctx: {
    term: "Context words",
    technical: "Mean total words across the top 5 retrieved chunks, per question.",
    plain:
      "How much text the assistant has to read for one question. Lower is better at equal accuracy: it is cheaper, faster, and gives the model less irrelevant material to get distracted by.",
  },
  ca: {
    term: "Confidence, answerable",
    technical: "Mean retrieval confidence on questions the site's own documentation answers.",
    plain: "How sure the system is when the answer really is in the docs. Should be high.",
  },
  cu: {
    term: "Confidence, unanswerable",
    technical:
      "Mean retrieval confidence on questions borrowed from other sites, which this corpus cannot answer.",
    plain:
      "How sure the system is when the answer is not there at all. Should be low. The gap between this and the column before it is the whole knowledge-gap signal.",
  },
  auroc: {
    term: "Gap AUROC",
    technical:
      "Area under the ROC curve for confidence as a classifier of answerable versus unanswerable questions.",
    plain:
      "The chance that a random answerable question scores higher confidence than a random unanswerable one. 1.0 means the two never overlap and the system always knows what it does not know; 0.5 means coin-flip and the confidence score is worthless. This is the number that decides whether the insights layer can trust low confidence as evidence of a documentation gap.",
  },
  fg: {
    term: "False gaps",
    technical: "Answerable questions whose confidence falls below τ and are flagged as gaps anyway.",
    plain:
      "Documented things wrongly reported as missing. Too many of these and the client is sent to rewrite pages that were already fine.",
  },
  mg: {
    term: "Missed gaps",
    technical: "Unanswerable questions whose confidence sits above τ and pass unflagged.",
    plain:
      "Real holes in the documentation that slipped through unreported. Too many of these and the system quietly stops earning its keep.",
  },
  tau: {
    term: "Best τ",
    technical:
      "The confidence threshold maximising balanced accuracy on this site and configuration.",
    plain:
      "Where the line between 'answered' and 'gap' should sit for this site. If the best line is roughly the same everywhere, one setting can serve new organisations without tuning.",
  },
  mean: {
    term: "Mean words",
    technical: "Mean chunk length in words.",
    plain: "The typical size of a piece. Compare it against the size the chunker was asked for.",
  },
  p10: {
    term: "P10 words",
    technical: "10th percentile of chunk length.",
    plain: "Nine chunks in ten are longer than this. A very low figure means a tail of scraps.",
  },
  p90: {
    term: "P90 words",
    technical: "90th percentile of chunk length.",
    plain: "Nine chunks in ten are shorter than this. Read with P10, it shows how even the cuts are.",
  },
  tiny: {
    term: "Tiny chunks",
    technical: "Proportion of chunks under 50 words.",
    plain:
      "Fragments too short to answer anything — a stray heading, a one-line note. They clutter the index and can crowd out a real passage in the top five.",
  },
  cross: {
    term: "Cross-section",
    technical: "Proportion of chunks spanning a heading boundary.",
    plain:
      "Pieces that run across a heading, so they end up half about one thing and half about another. A match on such a chunk is half wasted context, which is exactly the failure [L4] identifies.",
  },
  code: {
    term: "Code blocks split",
    technical: "Proportion of code blocks divided across a chunk boundary.",
    plain:
      "Code examples cut in two. Half a snippet retrieved on its own is worse than useless in developer documentation: it looks like an answer and will not run.",
  },
};

const label = (chunker: string) => chunkerCopy[chunker]?.label ?? chunker;
const num = (v: number | null | undefined, digits = 3) => (v == null ? "–" : v.toFixed(digits));
const share = (v: number | null | undefined) => (v == null ? "–" : pct(v, 1));

// ---------------------------------------------------------------------------

export function RunMeta({ run }: { run: ResearchSummary }) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-small text-ink-soft">
      <span>Run {dateLabel(run.created_at)}</span>
      <span>Embedding model {run.embedding_model.split("/").pop()}</span>
      <span>Top {run.k} retrieved</span>
      <span>Gap threshold {run.tau}</span>
      <span>Overlap {run.overlap} words</span>
    </div>
  );
}

export function SitesTable({ run }: { run: ResearchSummary }) {
  return (
    <section>
      <SectionHeader
        title="Documentation sites"
        description="Each site was crawled once and frozen, so every chunker read identical pages."
      />
      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-left">
          <thead>
            <tr className="border-b border-rule-strong text-micro text-ink-faint">
              <th className="px-4 py-3 font-medium">Site</th>
              <th className="px-4 py-3 font-medium">Built with</th>
              <th className="px-4 py-3 text-right font-medium">Pages</th>
              <th className="px-4 py-3 text-right font-medium">Words</th>
              <th className="px-4 py-3 font-medium">Crawled</th>
              <th className="px-4 py-3 text-right font-medium">Questions</th>
              <th className="px-4 py-3 text-right font-medium">Accepted on review</th>
            </tr>
          </thead>
          <tbody>
            {run.sites.map((s) => (
              <tr key={s.site} className="border-b border-rule text-small last:border-b-0">
                <td className="px-4 py-3 font-medium">{s.name}</td>
                <td className="px-4 py-3 text-ink-soft">{s.generator}</td>
                <td className="tabular px-4 py-3 text-right">{s.pages}</td>
                <td className="tabular px-4 py-3 text-right">{s.words.toLocaleString()}</td>
                <td className="px-4 py-3 text-ink-soft">{s.crawled_at ? dateLabel(s.crawled_at) : "–"}</td>
                <td className="tabular px-4 py-3 text-right">{s.questions}</td>
                <td className="tabular px-4 py-3 text-right">
                  {s.review.reviewed
                    ? `${s.review.accepted_of_reviewed} of ${s.review.reviewed} (${pct(s.review.acceptance_rate ?? 0)})`
                    : "Not reviewed"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </section>
  );
}

// ---------------------------------------------------------------------------

type ChartMetric = "mrr" | "recallk" | "hitk" | "auroc";

export function ComparisonChart({ results, k }: { results: ResearchResult[]; k: number }) {
  const [metric, setMetric] = useState<ChartMetric>("mrr");
  const metrics: { key: ChartMetric; label: string }[] = [
    { key: "mrr", label: "MRR" },
    { key: "recallk", label: `Recall@${k}` },
    { key: "hitk", label: `Hit@${k}` },
    { key: "auroc", label: "Gap AUROC" },
  ];
  const chunkers = [...new Set(results.map((r) => r.chunker))];
  const data = useMemo(() => {
    const sites = [...new Set(results.map((r) => r.site))];
    return sites.map((site) => {
      const row: Record<string, string | number | null> = { site };
      for (const r of results.filter((x) => x.site === site)) row[r.chunker] = r.retrieval[metric];
      return row;
    });
  }, [results, metric]);

  return (
    <Panel className="p-5">
      <SectionHeader
        title="Chunkers side by side"
        description={
          metric === "auroc"
            ? "How well retrieval confidence separates answerable from unanswerable questions. 0.5 is chance."
            : "Retrieval quality on questions the site's documentation answers."
        }
        action={
          <div role="tablist" className="flex gap-1 rounded border border-rule-strong bg-paper p-1">
            {metrics.map((m) => (
              <button
                key={m.key}
                role="tab"
                aria-selected={metric === m.key}
                onClick={() => setMetric(m.key)}
                className={clsx(
                  "rounded px-2.5 py-1 text-small transition-colors",
                  metric === m.key ? "bg-paper-raised font-medium text-ink shadow-sm" : "text-ink-soft hover:text-ink",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        }
      />
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barCategoryGap="22%">
            <CartesianGrid stroke={palette.rule} strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="site" tick={axisTick} axisLine={{ stroke: palette.rule }} tickLine={false} />
            <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tick={axisTick} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ fill: palette.paperSunk }}
              contentStyle={tooltipStyle}
              formatter={(v: number, name: string) => [v == null ? "–" : v.toFixed(3), label(name)]}
            />
            <Legend formatter={(v: string) => <span className="text-small text-ink-soft">{label(v)}</span>} />
            {chunkers.map((c) => (
              <Bar key={c} dataKey={c} fill={chunkerCopy[c]?.colour ?? palette.ruleStrong} radius={[2, 2, 0, 0]} maxBarSize={36} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

interface Column {
  key: string;
  label: string;
  value: (r: ResearchResult) => number | null;
  show: (v: number | null) => string;
  better?: "high" | "low";
}

/**
 * A column heading that can explain itself. The definition is in a <details>
 * rather than a title attribute so it works on touch, stays open while it is
 * read, and is reachable by keyboard — a tooltip meets none of those.
 */
function ColumnHeading({ column }: { column: Column }) {
  const entry = glossary[column.key];
  if (!entry) return <>{column.label}</>;
  return (
    <details className="group relative inline-block text-right">
      <summary className="cursor-help list-none underline decoration-dotted decoration-from-font underline-offset-4 hover:text-ink">
        {column.label}
        <span className="sr-only"> — show what this measures</span>
      </summary>
      <div className="absolute right-0 top-full z-20 mt-1.5 w-72 rounded-md border border-rule-strong bg-paper-raised p-3 text-left shadow-lg">
        <p className="text-small font-medium text-ink">{entry.term}</p>
        <p className="mt-1.5 text-micro text-ink-soft">{entry.technical}</p>
        <p className="mt-2 border-t border-rule pt-2 text-micro text-ink-soft">{entry.plain}</p>
        {column.better && (
          <p className="mt-2 text-micro text-ink-faint">
            {column.better === "high" ? "Higher is better." : "Lower is better."}
          </p>
        )}
      </div>
    </details>
  );
}

/**
 * What a whole section is for, in both registers. The technical line is what the
 * section already said; the plain line is what someone arriving from outside the
 * field needs before the numbers mean anything. Collapsed by default so a reader
 * who already knows is not made to scroll past it every time.
 */
export function SectionExplainer({ plain }: { plain: string }) {
  return (
    <details className="group mt-3">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-small text-oxblood underline underline-offset-4">
        <span className="group-open:hidden">What is this section measuring?</span>
        <span className="hidden group-open:inline">Hide</span>
      </summary>
      <p className="mt-2 max-w-measure border-l-2 border-rule-strong pl-4 text-small text-ink-soft">
        {plain}
      </p>
    </details>
  );
}

/** A legend for what the marked cells mean, shown under each metric table. */
function BestCellLegend({ columns }: { columns: Column[] }) {
  if (!columns.some((c) => c.better)) return null;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-2 px-4 pb-3 text-micro text-ink-faint">
      <span aria-hidden className="inline-block h-3 w-6 rounded-sm bg-oxblood-wash ring-1 ring-inset ring-oxblood/30" />
      Best value for that site. Hover or tap a column heading to see what it measures.
    </p>
  );
}

/** One table per site, with the best value in each column marked. */
export function MetricTable({
  title,
  description,
  results,
  columns,
}: {
  title: string;
  description: string;
  results: ResearchResult[];
  columns: Column[];
}) {
  const sites = [...new Set(results.map((r) => r.site))];
  return (
    <section>
      <SectionHeader title={title} description={description} />
      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-left">
          <thead>
            <tr className="border-b border-rule-strong text-micro text-ink-faint">
              <th className="px-4 py-3 font-medium">Site</th>
              <th className="px-4 py-3 font-medium">Chunker</th>
              {columns.map((c) => (
                <th key={c.key} className="px-4 py-3 text-right font-medium">
                  <ColumnHeading column={c} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => {
              const rows = results.filter((r) => r.site === site);
              const best = Object.fromEntries(
                columns.map((c) => {
                  const vals = rows.map(c.value).filter((v): v is number => v != null);
                  // No winner to mark when every row has the same value.
                  if (!c.better || !vals.length || new Set(vals).size === 1) return [c.key, null];
                  return [c.key, c.better === "high" ? Math.max(...vals) : Math.min(...vals)];
                }),
              );
              return rows.map((r, n) => (
                <tr
                  key={r.config + r.site}
                  className={clsx("text-small", n === rows.length - 1 ? "border-b border-rule-strong last:border-b-0" : "border-b border-rule")}
                >
                  <td className="px-4 py-2.5 font-medium">{n === 0 ? site : ""}</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-2">
                      <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: chunkerCopy[r.chunker]?.colour }} />
                      {label(r.chunker)}
                      <span className="text-micro text-ink-faint">{r.size}w</span>
                    </span>
                  </td>
                  {columns.map((c) => {
                    const v = c.value(r);
                    const isBest = v != null && best[c.key] === v && rows.length > 1;
                    return (
                      <td
                        key={c.key}
                        // The winner is marked on the cell, not only the number.
                        // Colouring four characters of text in a table this wide
                        // was almost invisible, and invisible to anyone reading
                        // it in greyscale or with a colour deficiency — hence the
                        // ring and the weight as well as the tint.
                        className={clsx(
                          "tabular px-4 py-2.5 text-right",
                          isBest
                            ? "bg-oxblood-wash font-semibold text-oxblood-deep ring-1 ring-inset ring-oxblood/30"
                            : "text-ink",
                        )}
                        title={isBest ? `Best ${c.label} for ${site}` : undefined}
                      >
                        {c.show(v)}
                        {isBest && <span className="sr-only"> — best for this site</span>}
                      </td>
                    );
                  })}
                </tr>
              ));
            })}
          </tbody>
        </table>
        <BestCellLegend columns={columns} />
      </Panel>
    </section>
  );
}

export const retrievalColumns = (k: number): Column[] => [
  { key: "chunks", label: "Chunks", value: (r) => r.chunk_stats.chunks, show: (v) => (v == null ? "–" : v.toLocaleString()) },
  { key: "hit1", label: "Hit@1", value: (r) => r.retrieval.hit1, show: (v) => num(v), better: "high" },
  { key: "hitk", label: `Hit@${k}`, value: (r) => r.retrieval.hitk, show: (v) => num(v), better: "high" },
  { key: "mrr", label: "MRR", value: (r) => r.retrieval.mrr, show: (v) => num(v), better: "high" },
  { key: "recallk", label: `Recall@${k}`, value: (r) => r.retrieval.recallk, show: (v) => num(v), better: "high" },
  { key: "page", label: `Page hit@${k}`, value: (r) => r.retrieval.page_hitk, show: (v) => num(v), better: "high" },
  { key: "ctx", label: "Context words", value: (r) => r.retrieval.context_words, show: (v) => (v == null ? "–" : v.toFixed(0)), better: "low" },
];

export const gapColumns: Column[] = [
  { key: "ca", label: "Conf. answerable", value: (r) => r.retrieval.mean_conf_answerable, show: (v) => num(v) },
  { key: "cu", label: "Conf. unanswerable", value: (r) => r.retrieval.mean_conf_unanswerable, show: (v) => num(v) },
  { key: "auroc", label: "AUROC", value: (r) => r.retrieval.auroc, show: (v) => num(v), better: "high" },
  { key: "fg", label: "False gaps", value: (r) => r.retrieval.false_gap, show: share, better: "low" },
  { key: "mg", label: "Missed gaps", value: (r) => r.retrieval.missed_gap, show: share, better: "low" },
  { key: "tau", label: "Best τ", value: (r) => r.retrieval.best_tau, show: (v) => num(v, 2) },
];

export const qualityColumns: Column[] = [
  { key: "mean", label: "Mean words", value: (r) => r.chunk_stats.words.mean, show: (v) => (v == null ? "–" : v.toFixed(0)) },
  { key: "p10", label: "P10 words", value: (r) => r.chunk_stats.words.p10, show: (v) => (v == null ? "–" : v.toFixed(0)) },
  { key: "p90", label: "P90 words", value: (r) => r.chunk_stats.words.p90, show: (v) => (v == null ? "–" : v.toFixed(0)) },
  { key: "tiny", label: "Tiny (<50 words)", value: (r) => r.chunk_stats.tiny_rate, show: share, better: "low" },
  { key: "cross", label: "Cross-section", value: (r) => r.chunk_stats.cross_section_rate, show: share, better: "low" },
  { key: "code", label: "Code blocks split", value: (r) => r.chunk_stats.code_split_rate, show: share, better: "low" },
];

// ---------------------------------------------------------------------------

export function SignificanceTable({ run }: { run: ResearchSummary }) {
  if (!run.comparisons.length) return null;
  return (
    <section>
      <SectionHeader
        title="Is the difference real?"
        description="Paired bootstrap over the same questions, 2000 resamples. A difference counts when its 95% interval excludes zero."
      />
      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left">
          <thead>
            <tr className="border-b border-rule-strong text-micro text-ink-faint">
              <th className="px-4 py-3 font-medium">Site</th>
              <th className="px-4 py-3 font-medium">Compared with heading-aware</th>
              <th className="px-4 py-3 font-medium">Metric</th>
              <th className="px-4 py-3 text-right font-medium">Difference</th>
              <th className="px-4 py-3 text-right font-medium">95% interval</th>
              <th className="px-4 py-3 font-medium">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {run.comparisons.map((c, n) => (
              <tr key={n} className="border-b border-rule text-small last:border-b-0">
                <td className="px-4 py-2.5">{c.site}</td>
                <td className="px-4 py-2.5">{label(c.config.split("@")[0])} <span className="text-micro text-ink-faint">{c.config.split("@")[1]}w</span></td>
                <td className="px-4 py-2.5">{c.metric}</td>
                <td className={clsx("tabular px-4 py-2.5 text-right", (c.mean_diff ?? 0) > 0 ? "text-olive" : "text-oxblood")}>
                  {c.mean_diff == null ? "–" : `${c.mean_diff > 0 ? "+" : ""}${c.mean_diff.toFixed(3)}`}
                </td>
                <td className="tabular px-4 py-2.5 text-right text-ink-soft">
                  {num(c.ci_low)} to {num(c.ci_high)}
                </td>
                <td className="px-4 py-2.5">
                  {c.significant ? (
                    <span className="font-medium">{(c.mean_diff ?? 0) > 0 ? "Better" : "Worse"}</span>
                  ) : (
                    <span className="text-ink-faint">No clear difference</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </section>
  );
}

export function TransferTable({ run }: { run: ResearchSummary }) {
  if (!run.transfer.length) return null;
  return (
    <section>
      <SectionHeader
        title="Does one gap threshold work on another site?"
        description="The threshold is tuned on one site and applied unchanged to the other. Close scores mean one setting can serve new organisations."
      />
      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left">
          <thead>
            <tr className="border-b border-rule-strong text-micro text-ink-faint">
              <th className="px-4 py-3 font-medium">Chunker</th>
              <th className="px-4 py-3 font-medium">Tuned on</th>
              <th className="px-4 py-3 font-medium">Applied to</th>
              <th className="px-4 py-3 text-right font-medium">Threshold</th>
              <th className="px-4 py-3 text-right font-medium">Accuracy, transferred</th>
              <th className="px-4 py-3 text-right font-medium">Accuracy, own best</th>
            </tr>
          </thead>
          <tbody>
            {run.transfer.map((t, n) => (
              <tr key={n} className="border-b border-rule text-small last:border-b-0">
                <td className="px-4 py-2.5">{label(t.config.split("@")[0])} <span className="text-micro text-ink-faint">{t.config.split("@")[1]}w</span></td>
                <td className="px-4 py-2.5">{t.from}</td>
                <td className="px-4 py-2.5">{t.to}</td>
                <td className="tabular px-4 py-2.5 text-right">{t.tau.toFixed(2)}</td>
                <td className="tabular px-4 py-2.5 text-right">{share(t.balanced_transferred)}</td>
                <td className="tabular px-4 py-2.5 text-right text-ink-soft">{share(t.balanced_own)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </section>
  );
}

export function MethodNote({ run }: { run: ResearchSummary }) {
  return (
    <section className="max-w-measure text-small text-ink-soft">
      <h2 className="mb-2 text-h3 font-semibold text-ink">How these are measured</h2>
      <p>
        Each question was written from one gold passage of 40 to 120 words. A retrieved chunk counts as relevant when it
        holds at least {pct(run.relevance_threshold)} of that passage, or lies at least {pct(run.containment_threshold)}{" "}
        inside it, judged by overlapping three-word sequences. Recall@{run.k} measures how much of the passage the top{" "}
        {run.k} chunks cover together, so it rewards finding an answer a chunker split in two.
      </p>
      <p className="mt-2">
        Unanswerable questions are borrowed from the other sites in the run. A question is flagged as a knowledge gap when
        its retrieval confidence falls below {run.tau}; false gaps are answerable questions flagged anyway, missed gaps are
        unanswerable ones that slipped through.
      </p>
    </section>
  );
}
