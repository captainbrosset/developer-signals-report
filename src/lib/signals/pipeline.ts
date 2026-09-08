import { features as webFeatures, groups } from 'web-features';
import {
  FORMULA_VERSION,
  QUALIFICATION_VERSION,
  STALE_AFTER_HOURS,
} from './constants';
import type {
  Browser,
  FeatureSignal,
  ManualOverride,
  RawComment,
  Report,
  ScoreSnapshot,
} from './model';
import { reportSchema } from './model';
import {
  deduplicateQualifiedAuthors,
  qualifyComment,
} from './qualification';
import {
  calculateComponentsFromMetrics,
  calculateConfidence,
  calculateScore,
} from './scoring';

export interface RawFeatureInput {
  id: string;
  issueUrl: string;
  title?: string;
  votes: number;
  comments: RawComment[];
  lastActivityAt: string;
  previousSnapshots?: ScoreSnapshot[];
  historicalMetrics?: {
    date: string;
    votes: number;
    qualifiedAuthors: number;
    reactionBoost: number;
    workaroundBurdenRaw: number;
  }[];
}

export interface BuildReportOptions {
  generatedAt: string;
  fixture: boolean;
  inputs: RawFeatureInput[];
  overrides?: ManualOverride[];
  sourceRetrievedAt?: string;
  warnings?: string[];
}

export function buildFeatureSignal(
  input: RawFeatureInput,
  overrides: ManualOverride[] = [],
): FeatureSignal {
  const issue = parseIssueUrl(input.issueUrl);
  const feature = resolveFeature(input.id);
  const comments = deduplicateQualifiedAuthors(
    input.comments.map((comment) =>
      qualifyComment(
        comment,
        overrides.find((override) => override.sourceId === comment.id),
      ),
    ),
  );
  const qualifiedComments = comments.filter(
    (comment) => comment.classification === 'qualified',
  );
  const score = calculateScore({
    votes: input.votes,
    qualifiedComments,
  });
  const generatedAtDate = input.lastActivityAt.slice(0, 10);
  const currentSnapshot: ScoreSnapshot = {
    date: generatedAtDate,
    votes: input.votes,
    qualifiedAuthors: score.qualifiedAuthors,
    reactionBoost: score.reactionBoost,
    workaroundBurdenRaw: score.workaroundBurdenRaw,
    formulaVersion: FORMULA_VERSION,
    components: score.components,
  };
  const generatedSnapshots = (input.historicalMetrics ?? []).map((metric) => {
    const components = calculateComponentsFromMetrics({
      votes: metric.votes,
      qualifiedAuthors: metric.qualifiedAuthors,
      reactionBoost: metric.reactionBoost,
      workaroundBurdenRaw: metric.workaroundBurdenRaw,
    });
    return {
      date: metric.date,
      votes: metric.votes,
      qualifiedAuthors: metric.qualifiedAuthors,
      reactionBoost: metric.reactionBoost,
      workaroundBurdenRaw: metric.workaroundBurdenRaw,
      formulaVersion: FORMULA_VERSION,
      components,
    } satisfies ScoreSnapshot;
  });
  const snapshots = mergeSnapshots([
    ...(input.previousSnapshots ?? []),
    ...generatedSnapshots,
    currentSnapshot,
  ]);
  const current = snapshots.at(-1) ?? currentSnapshot;
  const sevenDay = nearestSnapshot(snapshots, current.date, 7);
  const thirtyDay = nearestSnapshot(snapshots, current.date, 30);
  const excludedCount = comments.filter(
    (comment) => comment.classification === 'excluded',
  ).length;

  return {
    id: input.id,
    slug: input.id,
    title: feature?.name ?? input.title ?? titleFromId(input.id),
    summary:
      feature?.description ??
      `Developer demand and implementation evidence for ${titleFromId(input.id)}.`,
    summaryKind: feature ? 'source' : 'editorial',
    issue,
    featureUrl: `https://web-platform-dx.github.io/web-features-explorer/features/${input.id}/`,
    categories: getCategories(feature?.group),
    supportState: getSupportState(feature),
    missingBrowsers: getMissingBrowsers(feature),
    votes: input.votes,
    qualifiedAuthors: score.qualifiedAuthors,
    reactionBoost: score.reactionBoost,
    workaroundBurdenRaw: score.workaroundBurdenRaw,
    workaroundAuthors: score.workaroundAuthors,
    score: score.components,
    confidence: calculateConfidence(
      score.qualifiedAuthors,
      input.votes,
      excludedCount,
    ),
    trend: {
      votes7d: current.votes - (sevenDay?.votes ?? current.votes),
      votes30d: current.votes - (thirtyDay?.votes ?? current.votes),
      score7d: round(
        current.components.composite -
          (sevenDay?.components.composite ?? current.components.composite),
      ),
      score30d: round(
        current.components.composite -
          (thirtyDay?.components.composite ?? current.components.composite),
      ),
    },
    comments,
    snapshots,
    lastActivityAt: input.lastActivityAt,
  };
}

export function buildReport(options: BuildReportOptions): Report {
  const retrievedAt = options.sourceRetrievedAt ?? options.generatedAt;
  const staleAfter = new Date(
    new Date(options.generatedAt).getTime() + STALE_AFTER_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const report = {
    metadata: {
      generatedAt: options.generatedAt,
      staleAfter,
      formulaVersion: FORMULA_VERSION,
      qualificationVersion: QUALIFICATION_VERSION,
      fixture: options.fixture,
      complete: true as const,
      sources: [
        {
          name: 'web-features developer signals',
          url: 'https://web-platform-dx.github.io/developer-signals/web-features-signals.json',
          retrievedAt,
        },
        {
          name: 'GitHub issues and comments',
          url: 'https://github.com/web-platform-dx/developer-signals/issues',
          retrievedAt,
        },
        {
          name: 'web-features',
          url: 'https://github.com/web-platform-dx/web-features',
          retrievedAt,
        },
      ],
      warnings: options.warnings ?? [],
    },
    features: options.inputs
      .map((input) => buildFeatureSignal(input, options.overrides))
      .sort((a, b) => b.score.composite - a.score.composite),
  };
  return reportSchema.parse(report);
}

function resolveFeature(id: string) {
  let candidate = webFeatures[id];
  const visited = new Set<string>();
  while (candidate && candidate.kind === 'moved') {
    if (visited.has(id)) return undefined;
    visited.add(id);
    candidate = webFeatures[candidate.redirect_target];
  }
  return candidate?.kind === 'feature' ? candidate : undefined;
}

function getCategories(groupIds?: string[]): string[] {
  if (!groupIds?.length) return ['Other'];
  return groupIds
    .map((id) => groups[id]?.name ?? titleFromId(id))
    .filter((value, index, values) => values.indexOf(value) === index);
}

function getSupportState(
  feature: ReturnType<typeof resolveFeature>,
): FeatureSignal['supportState'] {
  if (!feature) return 'unknown';
  if (feature.discouraged) return 'discouraged';
  if (feature.status.baseline === 'high') return 'widely-available';
  if (feature.status.baseline === 'low') return 'newly-available';
  if (feature.status.baseline === false) return 'limited';
  return 'unknown';
}

function getMissingBrowsers(
  feature: ReturnType<typeof resolveFeature>,
): Browser[] {
  if (!feature || feature.status.baseline !== false) return [];
  const support = feature.status.support ?? {};
  return (['chrome', 'edge', 'firefox', 'safari'] as const).filter(
    (browser) => support[browser] === undefined,
  );
}

function parseIssueUrl(url: string): FeatureSignal['issue'] {
  const parsed = new URL(url);
  const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(parsed.pathname);
  if (!match) throw new Error(`Invalid GitHub issue URL: ${url}`);
  return {
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
    url,
  };
}

function mergeSnapshots(snapshots: ScoreSnapshot[]): ScoreSnapshot[] {
  const byDate = new Map<string, ScoreSnapshot>();
  for (const snapshot of snapshots) byDate.set(snapshot.date, snapshot);
  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-31);
}

function nearestSnapshot(
  snapshots: ScoreSnapshot[],
  currentDate: string,
  days: number,
): ScoreSnapshot | undefined {
  const target =
    new Date(`${currentDate}T00:00:00Z`).getTime() - days * 86_400_000;
  return snapshots
    .filter(
      (snapshot) =>
        new Date(`${snapshot.date}T00:00:00Z`).getTime() <= target,
    )
    .at(-1);
}

function titleFromId(id: string): string {
  return id
    .split('-')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
