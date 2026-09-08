import { z } from 'zod';

export const browserSchema = z.enum(['chrome', 'edge', 'firefox', 'safari']);
export const supportStateSchema = z.enum([
  'limited',
  'newly-available',
  'widely-available',
  'discouraged',
  'unknown',
]);
export const workaroundSeveritySchema = z.enum([
  'none',
  'light',
  'moderate',
  'high',
  'blocked',
]);
export const commentClassificationSchema = z.enum([
  'qualified',
  'excluded',
  'ambiguous',
]);
export const exclusionReasonSchema = z.enum([
  'bot',
  'minimized',
  'moderation',
  'template-only',
  'generic-support',
  'debate-only',
  'duplicate-author',
  'insufficient-specificity',
  'manual-exclusion',
]);

export const issueIdentitySchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  url: z.url(),
});

export const commentSignalSchema = z.object({
  id: z.string(),
  author: z.string(),
  authorAssociation: z.string().optional(),
  sourceUrl: z.url(),
  createdAt: z.iso.datetime(),
  body: z.string(),
  parsedGoal: z.string().optional(),
  parsedWorkaround: z.string().optional(),
  positiveReactions: z.number().int().nonnegative(),
  classification: commentClassificationSchema,
  exclusionReason: exclusionReasonSchema.optional(),
  themes: z.array(z.string()),
  workaroundSeverity: workaroundSeveritySchema,
  generatedSummary: z.string().optional(),
  summaryKind: z.enum(['source-excerpt', 'editorial', 'ai-generated']).optional(),
});

export const scoreComponentsSchema = z.object({
  voteDemand: z.number().min(0).max(100),
  useCaseEvidence: z.number().min(0).max(100),
  workaroundBurden: z.number().min(0).max(100),
  composite: z.number().min(0).max(100),
});

export const scoreSnapshotSchema = z.object({
  date: z.iso.date(),
  votes: z.number().int().nonnegative(),
  qualifiedAuthors: z.number().int().nonnegative(),
  reactionBoost: z.number().nonnegative(),
  workaroundBurdenRaw: z.number().nonnegative(),
  formulaVersion: z.string(),
  components: scoreComponentsSchema,
});

export const confidenceSchema = z.object({
  level: z.enum(['low', 'medium', 'high']),
  score: z.number().min(0).max(1),
  rationale: z.string(),
});

export const featureSignalSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  summaryKind: z.enum(['source', 'editorial', 'ai-generated']),
  issue: issueIdentitySchema,
  featureUrl: z.url().optional(),
  categories: z.array(z.string()).min(1),
  supportState: supportStateSchema,
  missingBrowsers: z.array(browserSchema),
  votes: z.number().int().nonnegative(),
  qualifiedAuthors: z.number().int().nonnegative(),
  reactionBoost: z.number().nonnegative(),
  workaroundBurdenRaw: z.number().nonnegative(),
  workaroundAuthors: z.number().int().nonnegative(),
  score: scoreComponentsSchema,
  confidence: confidenceSchema,
  trend: z.object({
    votes7d: z.number().int(),
    votes30d: z.number().int(),
    score7d: z.number(),
    score30d: z.number(),
  }),
  comments: z.array(commentSignalSchema),
  snapshots: z.array(scoreSnapshotSchema).min(1),
  lastActivityAt: z.iso.datetime(),
});

export const manualOverrideSchema = z.object({
  sourceId: z.string(),
  classification: commentClassificationSchema.optional(),
  exclusionReason: exclusionReasonSchema.optional(),
  parsedGoal: z.string().optional(),
  parsedWorkaround: z.string().optional(),
  workaroundSeverity: workaroundSeveritySchema.optional(),
  themes: z.array(z.string()).optional(),
  generatedSummary: z.string().optional(),
  summaryKind: z.enum(['editorial', 'ai-generated']).optional(),
  rationale: z.string(),
  reviewer: z.string(),
  reviewedAt: z.iso.date(),
});

export const overridesFileSchema = z.object({
  version: z.number().int().positive(),
  overrides: z.array(manualOverrideSchema),
});

export const reportSchema = z.object({
  metadata: z.object({
    generatedAt: z.iso.datetime(),
    staleAfter: z.iso.datetime(),
    formulaVersion: z.string(),
    qualificationVersion: z.string(),
    fixture: z.boolean(),
    complete: z.literal(true),
    sources: z.array(
      z.object({
        name: z.string(),
        url: z.url(),
        retrievedAt: z.iso.datetime(),
      }),
    ),
    warnings: z.array(z.string()),
  }),
  features: z.array(featureSignalSchema).min(25),
});

export type Browser = z.infer<typeof browserSchema>;
export type WorkaroundSeverity = z.infer<typeof workaroundSeveritySchema>;
export type CommentSignal = z.infer<typeof commentSignalSchema>;
export type ScoreComponents = z.infer<typeof scoreComponentsSchema>;
export type ScoreSnapshot = z.infer<typeof scoreSnapshotSchema>;
export type FeatureSignal = z.infer<typeof featureSignalSchema>;
export type Report = z.infer<typeof reportSchema>;

export interface RawComment {
  id: string;
  author: string;
  authorAssociation?: string;
  sourceUrl: string;
  createdAt: string;
  body: string;
  positiveReactions: number;
  minimized?: boolean;
}

export type ManualOverride = z.infer<typeof manualOverrideSchema>;
