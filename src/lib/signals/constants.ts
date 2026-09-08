export const FORMULA_VERSION = '1.0.0';
export const QUALIFICATION_VERSION = '1.0.0';

export const SCORE_WEIGHTS = {
  votes: 0.5,
  useCases: 0.35,
  workarounds: 0.15,
} as const;

export const NORMALIZATION_REFERENCES = {
  votes: 500,
  useCases: 32,
  workaroundBurden: 18,
} as const;

export const COMMENT_REACTION_BOOST = {
  perReaction: 0.04,
  maximumPerAuthor: 0.2,
  maximumShareOfQualifiedAuthors: 0.2,
} as const;

export const WORKAROUND_WEIGHTS = {
  none: 0,
  light: 0.25,
  moderate: 0.5,
  high: 0.75,
  blocked: 1,
} as const;

export const STALE_AFTER_HOURS = 48;

export const FORMULA_TEXT =
  'priority = 0.50 × vote demand + 0.35 × use-case evidence + 0.15 × workaround burden';
