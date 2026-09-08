import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildReport, type RawFeatureInput } from '../src/lib/signals/pipeline';
import { reportSchema } from '../src/lib/signals/model';

const existing = reportSchema.parse(
  JSON.parse(await readFile('src/data/report.json', 'utf8')),
);
const inputs: RawFeatureInput[] = existing.features.map((feature) => ({
  id: feature.id,
  issueUrl: feature.issue.url,
  title: feature.title,
  votes: feature.votes,
  lastActivityAt: feature.lastActivityAt,
  comments: feature.comments.map((comment) => ({
    id: comment.id,
    author: comment.author,
    authorAssociation: comment.authorAssociation,
    sourceUrl: comment.sourceUrl,
    createdAt: comment.createdAt,
    body: comment.body,
    positiveReactions: comment.positiveReactions,
    minimized: comment.exclusionReason === 'minimized',
  })),
}));
const report = buildReport({
  generatedAt: existing.metadata.generatedAt,
  fixture: existing.metadata.fixture,
  inputs,
  sourceRetrievedAt:
    existing.metadata.sources[0]?.retrievedAt ?? existing.metadata.generatedAt,
  warnings: existing.metadata.warnings,
});

await mkdir('src/data', { recursive: true });
await mkdir('public/data', { recursive: true });
const json = `${JSON.stringify(report, null, 2)}\n`;
await writeFile('src/data/report.json', json);
await writeFile('public/data/report.json', json);
console.log(`Rebuilt ${report.features.length} features from checked-in source data.`);
