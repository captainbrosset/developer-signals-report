import {
  COMMENT_REACTION_BOOST,
  FORMULA_VERSION,
  NORMALIZATION_REFERENCES,
  SCORE_WEIGHTS,
  WORKAROUND_WEIGHTS,
} from './constants';
import type {
  CommentSignal,
  ScoreComponents,
  WorkaroundSeverity,
} from './model';

export interface ScoreInput {
  votes: number;
  qualifiedComments: Pick<
    CommentSignal,
    'author' | 'positiveReactions' | 'workaroundSeverity'
  >[];
}

export function logNormalize(value: number, reference: number): number {
  if (value <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(reference));
}

export function calculateReactionBoost(
  comments: ScoreInput['qualifiedComments'],
): number {
  const boost = comments.reduce(
    (total, comment) =>
      total +
      Math.min(
        comment.positiveReactions * COMMENT_REACTION_BOOST.perReaction,
        COMMENT_REACTION_BOOST.maximumPerAuthor,
      ),
    0,
  );
  return Math.min(
    boost,
    comments.length * COMMENT_REACTION_BOOST.maximumShareOfQualifiedAuthors,
  );
}

export function calculateWorkaroundBurden(
  comments: ScoreInput['qualifiedComments'],
): number {
  return comments.reduce(
    (total, comment) =>
      total + WORKAROUND_WEIGHTS[comment.workaroundSeverity],
    0,
  );
}

export function calculateScore(input: ScoreInput): {
  components: ScoreComponents;
  qualifiedAuthors: number;
  reactionBoost: number;
  workaroundBurdenRaw: number;
  workaroundAuthors: number;
  formulaVersion: string;
} {
  const byAuthor = new Map<
    string,
    ScoreInput['qualifiedComments'][number]
  >();
  for (const comment of input.qualifiedComments) {
    const key = comment.author.toLowerCase();
    const previous = byAuthor.get(key);
    if (
      !previous ||
      workaroundValue(comment.workaroundSeverity) +
        comment.positiveReactions >
        workaroundValue(previous.workaroundSeverity) +
          previous.positiveReactions
    ) {
      byAuthor.set(key, comment);
    }
  }

  const comments = [...byAuthor.values()];
  const reactionBoost = calculateReactionBoost(comments);
  const workaroundBurdenRaw = calculateWorkaroundBurden(comments);
  const components = calculateComponentsFromMetrics({
    votes: input.votes,
    qualifiedAuthors: comments.length,
    reactionBoost,
    workaroundBurdenRaw,
  });

  return {
    components,
    qualifiedAuthors: comments.length,
    reactionBoost: round(reactionBoost, 3),
    workaroundBurdenRaw: round(workaroundBurdenRaw, 3),
    workaroundAuthors: comments.filter(
      (comment) => comment.workaroundSeverity !== 'none',
    ).length,
    formulaVersion: FORMULA_VERSION,
  };
}

export function calculateComponentsFromMetrics(input: {
  votes: number;
  qualifiedAuthors: number;
  reactionBoost: number;
  workaroundBurdenRaw: number;
}): ScoreComponents {
  const voteDemand =
    logNormalize(input.votes, NORMALIZATION_REFERENCES.votes) * 100;
  const useCaseEvidence =
    logNormalize(
      input.qualifiedAuthors + input.reactionBoost,
      NORMALIZATION_REFERENCES.useCases,
    ) * 100;
  const workaroundBurden =
    logNormalize(
      input.workaroundBurdenRaw,
      NORMALIZATION_REFERENCES.workaroundBurden,
    ) * 100;
  const composite =
    SCORE_WEIGHTS.votes * voteDemand +
    SCORE_WEIGHTS.useCases * useCaseEvidence +
    SCORE_WEIGHTS.workarounds * workaroundBurden;
  return {
    voteDemand: round(voteDemand),
    useCaseEvidence: round(useCaseEvidence),
    workaroundBurden: round(workaroundBurden),
    composite: round(composite),
  };
}

export function calculateConfidence(
  qualifiedAuthors: number,
  votes: number,
  excludedComments: number,
): { level: 'low' | 'medium' | 'high'; score: number; rationale: string } {
  const evidence = Math.min(1, qualifiedAuthors / 12);
  const demand = Math.min(1, Math.log1p(votes) / Math.log1p(100));
  const consistency =
    qualifiedAuthors + excludedComments === 0
      ? 0
      : qualifiedAuthors / (qualifiedAuthors + excludedComments);
  const score = round(0.5 * evidence + 0.3 * demand + 0.2 * consistency, 2);
  const level = score >= 0.72 ? 'high' : score >= 0.42 ? 'medium' : 'low';
  return {
    level,
    score,
    rationale: `${qualifiedAuthors} distinct qualified author${qualifiedAuthors === 1 ? '' : 's'}; ${votes} issue vote${votes === 1 ? '' : 's'}; ${Math.round(consistency * 100)}% of reviewed comments qualified.`,
  };
}

function workaroundValue(severity: WorkaroundSeverity): number {
  return WORKAROUND_WEIGHTS[severity] * 10;
}

function round(value: number, precision = 1): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
