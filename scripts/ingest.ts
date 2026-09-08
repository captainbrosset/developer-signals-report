import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { buildReport, type RawFeatureInput } from '../src/lib/signals/pipeline';
import type { ManualOverride, Report } from '../src/lib/signals/model';
import {
  overridesFileSchema,
  reportSchema,
} from '../src/lib/signals/model';

const SIGNALS_URL =
  process.env.SIGNALS_URL ??
  'https://web-platform-dx.github.io/developer-signals/web-features-signals.json';
const OWNER = 'web-platform-dx';
const REPO = 'developer-signals';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  throw new Error(
    'GITHUB_TOKEN is required for ingestion. Use the checked-in fixture for offline builds.',
  );
}

const signalEntrySchema = z.record(
  z.string(),
  z.object({
    url: z.url(),
    votes: z.number().int().nonnegative(),
  }),
);
const issueSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  labels: z.array(
    z.union([z.string(), z.object({ name: z.string().nullable() })]),
  ),
  updated_at: z.iso.datetime(),
  reactions: z
    .object({
      '+1': z.number().int().nonnegative(),
    })
    .loose(),
});
const commentConnectionSchema = z.object({
  data: z.object({
    repository: z.object({
      issue: z.object({
        comments: z.object({
          nodes: z.array(
            z.object({
              id: z.string(),
              url: z.url(),
              createdAt: z.iso.datetime(),
              body: z.string(),
              author: z.object({ login: z.string() }).nullable(),
              authorAssociation: z.string(),
              isMinimized: z.boolean(),
              reactionGroups: z.array(
                z.object({
                  content: z.string(),
                  users: z.object({
                    totalCount: z.number().int().nonnegative(),
                  }),
                }),
              ),
            }),
          ),
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullable(),
          }),
        }),
      }),
    }),
  }),
  performed_via_github_app: z.unknown().nullable().optional(),
});

const generatedAt = new Date().toISOString();
const signalsResponse = await fetch(SIGNALS_URL, {
  headers: { accept: 'application/json' },
});
if (!signalsResponse.ok) {
  throw new Error(`Signal feed failed with HTTP ${signalsResponse.status}.`);
}
const signals = signalEntrySchema.parse(await signalsResponse.json());
const previous = await readPreviousReport();
const inputs: RawFeatureInput[] = [];
const warnings: string[] = [];

for (const [id, signal] of Object.entries(signals)) {
  const issueNumber = issueNumberFromUrl(signal.url);
  const issue = issueSchema.parse(
    await githubJson(`/repos/${OWNER}/${REPO}/issues/${issueNumber}`),
  );
  const labelNames = issue.labels.map((label) =>
    typeof label === 'string' ? label : label.name,
  );
  if (issue.state !== 'open' || !labelNames.includes('feature')) continue;
  const comments = await githubComments(issueNumber);
  if (issue.reactions['+1'] !== signal.votes) {
    warnings.push(
      `${id}: feed votes ${signal.votes} differed from GitHub ${issue.reactions['+1']}; GitHub value used.`,
    );
  }
  inputs.push({
    id,
    issueUrl: issue.html_url,
    title: issue.title,
    votes: issue.reactions['+1'],
    lastActivityAt: issue.updated_at,
    previousSnapshots: previous?.features.find((feature) => feature.id === id)
      ?.snapshots,
    comments: comments.map((comment) => ({
      id: comment.id,
      author: comment.author?.login ?? 'ghost',
      authorAssociation: comment.authorAssociation,
      sourceUrl: comment.url,
      createdAt: comment.createdAt,
      body: comment.body,
      positiveReactions:
        comment.reactionGroups.find(
          (reaction) => reaction.content === 'THUMBS_UP',
        )?.users.totalCount ?? 0,
      minimized: comment.isMinimized,
    })),
  });
}

if (inputs.length < 25) {
  throw new Error(
    `Incomplete ingestion: expected at least 25 eligible features, received ${inputs.length}.`,
  );
}

const overridesFile = overridesFileSchema.parse(
  JSON.parse(await readFile('data/overrides.json', 'utf8')),
);
const aiEnrichment = await readOptionalOverrides('data/ai-enrichment.json');
const report = buildReport({
  generatedAt,
  fixture: false,
  inputs,
  overrides: mergeOverrides(aiEnrichment, overridesFile.overrides),
  sourceRetrievedAt: generatedAt,
  warnings,
});
await mkdir('src/data', { recursive: true });
await mkdir('public/data', { recursive: true });
const json = `${JSON.stringify(report, null, 2)}\n`;
await writeFile('src/data/report.json', json);
await writeFile('public/data/report.json', json);
console.log(
  `Ingested ${report.features.length} features with ${warnings.length} warning(s).`,
);

async function githubJson(path: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: githubHeaders(),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub ${path} failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return response.json();
}

async function githubComments(issueNumber: number) {
  const results: z.infer<
    typeof commentConnectionSchema
  >['data']['repository']['issue']['comments']['nodes'] = [];
  let cursor: string | null = null;
  for (let page = 1; page <= 100; page += 1) {
    const payload = commentConnectionSchema.parse(
      await githubGraphql(
        `query IssueComments($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            issue(number: $number) {
              comments(first: 100, after: $cursor) {
                nodes {
                  id
                  url
                  createdAt
                  body
                  author { login }
                  authorAssociation
                  isMinimized
                  reactionGroups {
                    content
                    users { totalCount }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { owner: OWNER, repo: REPO, number: issueNumber, cursor },
      ),
    );
    const connection = payload.data.repository.issue.comments;
    results.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return results;
    if (!connection.pageInfo.endCursor || connection.nodes.length === 0) {
      throw new Error(
        `GraphQL advertised an invalid next comments page for issue ${issueNumber}.`,
      );
    }
    cursor = connection.pageInfo.endCursor;
  }
  throw new Error(
    `GraphQL comments pagination exceeded 100 pages for issue ${issueNumber}.`,
  );
}

async function githubGraphql(
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      ...githubHeaders(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub GraphQL failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  const payload = (await response.json()) as {
    errors?: { message?: string }[];
  };
  if (payload.errors?.length) {
    throw new Error(
      `GitHub GraphQL schema/query failure: ${payload.errors
        .map((error) => error.message ?? 'unknown error')
        .join('; ')}`,
    );
  }
  return payload;
}

function githubHeaders(): HeadersInit {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${TOKEN}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'developer-signals-analysis',
  };
}

function issueNumberFromUrl(url: string): number {
  const match = /\/issues\/(\d+)$/.exec(new URL(url).pathname);
  if (!match) throw new Error(`Invalid signal issue URL: ${url}`);
  return Number(match[1]);
}

async function readPreviousReport(): Promise<Report | undefined> {
  try {
    return reportSchema.parse(
      JSON.parse(await readFile('src/data/report.json', 'utf8')),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined;
    }
    throw new Error('Existing report failed schema validation.', {
      cause: error,
    });
  }
}

async function readOptionalOverrides(path: string): Promise<ManualOverride[]> {
  try {
    return overridesFileSchema.parse(
      JSON.parse(await readFile(path, 'utf8')),
    ).overrides;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }
    throw new Error(`${path} failed schema validation.`, { cause: error });
  }
}

function mergeOverrides(
  ai: ManualOverride[],
  manual: ManualOverride[],
): ManualOverride[] {
  const merged = new Map(ai.map((override) => [override.sourceId, override]));
  for (const override of manual) {
    merged.set(override.sourceId, {
      ...merged.get(override.sourceId),
      ...override,
    });
  }
  return [...merged.values()];
}
