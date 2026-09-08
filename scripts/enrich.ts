import { readFile, writeFile } from 'node:fs/promises';
import { createAiAdapter } from '../src/lib/signals/ai-adapter';
import {
  overridesFileSchema,
  reportSchema,
  type ManualOverride,
} from '../src/lib/signals/model';

const adapter = createAiAdapter();
if (!adapter) {
  throw new Error(
    'AI enrichment is disabled. Set ENABLE_AI_ENRICHMENT=true and provider variables to run it.',
  );
}

const report = reportSchema.parse(
  JSON.parse(await readFile('src/data/report.json', 'utf8')),
);
const existing = overridesFileSchema.parse(
  JSON.parse(await readFile('data/ai-enrichment.json', 'utf8')),
);
const bySource = new Map(
  existing.overrides.map((override) => [override.sourceId, override]),
);
const limit = Math.max(1, Math.min(Number(process.env.AI_LIMIT ?? 50), 200));
const candidates = report.features
  .flatMap((feature) => feature.comments)
  .filter(
    (comment) =>
      comment.classification === 'ambiguous' ||
      comment.classification === 'qualified',
  )
  .filter((comment) => !bySource.has(comment.id))
  .slice(0, limit);

for (const comment of candidates) {
  const enrichment = await adapter.enrich({
    sourceId: comment.id,
    body: comment.body,
  });
  const override: ManualOverride = {
    sourceId: enrichment.sourceId,
    classification: enrichment.classification,
    themes: enrichment.themes,
    generatedSummary: enrichment.summary,
    summaryKind: 'ai-generated',
    workaroundSeverity: enrichment.workaroundSeverity,
    rationale: 'Schema-constrained optional AI enrichment; source remains linked.',
    reviewer: `ai:${process.env.AI_MODEL}`,
    reviewedAt: new Date().toISOString().slice(0, 10),
  };
  bySource.set(override.sourceId, override);
}

const output = overridesFileSchema.parse({
  version: 1,
  overrides: [...bySource.values()].sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId),
  ),
});
await writeFile(
  'data/ai-enrichment.json',
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(`Enriched ${candidates.length} comments.`);
