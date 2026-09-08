import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { buildReport, type RawFeatureInput } from '../src/lib/signals/pipeline';

const OWNER = 'web-platform-dx';
const REPO = 'developer-signals';
const FEATURE_COUNT = 30;
const SIGNALS_URL =
  'https://web-platform-dx.github.io/developer-signals/web-features-signals.json';
const TOKEN = process.env.GITHUB_TOKEN;

const signalEntrySchema = z.record(
  z.string(),
  z.object({
    url: z.url(),
    votes: z.number().int().nonnegative(),
  }),
);
const searchSchema = z.object({
  incomplete_results: z.boolean(),
  items: z.array(
    z.object({
      number: z.number().int().positive(),
      html_url: z.url(),
      title: z.string(),
      updated_at: z.iso.datetime(),
      reactions: z
        .object({
          '+1': z.number().int().nonnegative(),
        })
        .loose(),
    }),
  ),
});
const commentsSchema = z.array(
  z.object({
    id: z.number().int().positive(),
    html_url: z.url(),
    created_at: z.iso.datetime(),
    body: z.string(),
    author_association: z.string(),
    user: z.object({ login: z.string() }).nullable(),
    reactions: z
      .object({
        '+1': z.number().int().nonnegative(),
      })
      .loose(),
    minimized: z.unknown().optional(),
  }),
);

const generatedAt = new Date().toISOString();
const signalsResponse = await fetch(SIGNALS_URL, {
  headers: { accept: 'application/json' },
});
if (!signalsResponse.ok) {
  throw new Error(`Signal feed failed with HTTP ${signalsResponse.status}.`);
}
const signals = signalEntrySchema.parse(await signalsResponse.json());
const featureByIssue = new Map(
  Object.entries(signals).map(([featureId, signal]) => [
    issueNumberFromUrl(signal.url),
    featureId,
  ]),
);

const searchUrl = new URL('https://api.github.com/search/issues');
searchUrl.searchParams.set(
  'q',
  `repo:${OWNER}/${REPO} is:issue is:open label:feature`,
);
searchUrl.searchParams.set('sort', 'reactions-+1');
searchUrl.searchParams.set('order', 'desc');
searchUrl.searchParams.set('per_page', String(FEATURE_COUNT));
const searchResponse = await fetch(searchUrl, { headers: githubHeaders() });
if (!searchResponse.ok) {
  throw new Error(
    `GitHub issue search failed with HTTP ${searchResponse.status}: ${await searchResponse.text()}`,
  );
}
const search = searchSchema.parse(await searchResponse.json());
if (search.incomplete_results || search.items.length < 25) {
  throw new Error(
    `Incomplete GitHub search: received ${search.items.length} issues.`,
  );
}

const inputs: RawFeatureInput[] = [];
const warnings: string[] = [];
for (const issue of search.items) {
  const featureId = featureByIssue.get(issue.number);
  if (!featureId) {
    throw new Error(
      `Issue #${issue.number} was not present in the published signal feed.`,
    );
  }
  const commentsResponse = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/issues/${issue.number}/comments?per_page=100`,
    { headers: githubHeaders() },
  );
  if (!commentsResponse.ok) {
    throw new Error(
      `GitHub comments for #${issue.number} failed with HTTP ${commentsResponse.status}: ${await commentsResponse.text()}`,
    );
  }
  if (commentsResponse.headers.get('link')?.includes('rel="next"')) {
    throw new Error(
      `Issue #${issue.number} has more than 100 comments; authenticated ingestion is required for complete pagination.`,
    );
  }
  const comments = commentsSchema.parse(await commentsResponse.json());
  const feedVotes = signals[featureId].votes;
  if (feedVotes !== issue.reactions['+1']) {
    warnings.push(
      `${featureId}: feed votes ${feedVotes} differed from GitHub ${issue.reactions['+1']}; GitHub value used.`,
    );
  }
  inputs.push({
    id: featureId,
    issueUrl: issue.html_url,
    title: issue.title,
    votes: issue.reactions['+1'],
    lastActivityAt: issue.updated_at,
    comments: comments.map((comment) => ({
      id: String(comment.id),
      author: comment.user?.login ?? 'ghost',
      authorAssociation: comment.author_association,
      sourceUrl: comment.html_url,
      createdAt: comment.created_at,
      body: comment.body,
      positiveReactions: comment.reactions['+1'],
      minimized: comment.minimized === true,
    })),
  });
}

warnings.unshift(
  `Checked-in public API sample of the ${inputs.length} most-reacted open feature issues. Votes and comments are source-linked GitHub data; run authenticated ingestion for the complete report and history.`,
);
const report = buildReport({
  generatedAt,
  fixture: true,
  inputs,
  sourceRetrievedAt: generatedAt,
  warnings,
});

await mkdir('src/data', { recursive: true });
await mkdir('public/data', { recursive: true });
const json = `${JSON.stringify(report, null, 2)}\n`;
await writeFile('src/data/report.json', json);
await writeFile('public/data/report.json', json);
console.log(
  `Wrote ${report.features.length} source-linked sample features from GitHub.`,
);

function githubHeaders(): HeadersInit {
  return {
    accept: 'application/vnd.github+json',
    ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    'x-github-api-version': '2022-11-28',
    'user-agent': 'developer-signals-analysis',
  };
}

function issueNumberFromUrl(url: string): number {
  const match = /\/issues\/(\d+)$/.exec(new URL(url).pathname);
  if (!match) throw new Error(`Invalid signal issue URL: ${url}`);
  return Number(match[1]);
}
