import { describe, expect, it } from 'vitest';
import {
  calculateReactionBoost,
  calculateScore,
  logNormalize,
} from '../src/lib/signals/scoring';

const comment = (
  author: string,
  positiveReactions = 0,
  workaroundSeverity:
    | 'none'
    | 'light'
    | 'moderate'
    | 'high'
    | 'blocked' = 'none',
) => ({ author, positiveReactions, workaroundSeverity });

describe('scoring', () => {
  it('is zero without evidence and bounded at 100', () => {
    expect(calculateScore({ votes: 0, qualifiedComments: [] }).components).toEqual({
      voteDemand: 0,
      useCaseEvidence: 0,
      workaroundBurden: 0,
      composite: 0,
    });
    expect(logNormalize(1_000_000, 500)).toBe(1);
  });

  it('uses logarithmic vote normalization', () => {
    const ten = calculateScore({ votes: 10, qualifiedComments: [] });
    const hundred = calculateScore({ votes: 100, qualifiedComments: [] });
    const fiveHundred = calculateScore({
      votes: 500,
      qualifiedComments: [],
    });
    expect(hundred.components.voteDemand - ten.components.voteDemand).toBeGreaterThan(
      fiveHundred.components.voteDemand - hundred.components.voteDemand,
    );
  });

  it('deduplicates authors before scoring', () => {
    const one = calculateScore({
      votes: 0,
      qualifiedComments: [comment('A')],
    });
    const duplicates = calculateScore({
      votes: 0,
      qualifiedComments: [
        comment('A'),
        comment('a', 2, 'moderate'),
        comment('A', 0, 'blocked'),
      ],
    });
    expect(duplicates.qualifiedAuthors).toBe(1);
    expect(duplicates.components.useCaseEvidence).toBeGreaterThanOrEqual(
      one.components.useCaseEvidence,
    );
  });

  it('bounds reaction boost to twenty percent per author', () => {
    expect(calculateReactionBoost([comment('A', 10_000)])).toBe(0.2);
    expect(
      calculateReactionBoost([
        comment('A', 10_000),
        comment('B', 10_000),
      ]),
    ).toBe(0.4);
  });

  it('raises only the workaround component when burden increases', () => {
    const none = calculateScore({
      votes: 50,
      qualifiedComments: [comment('A')],
    });
    const blocked = calculateScore({
      votes: 50,
      qualifiedComments: [comment('A', 0, 'blocked')],
    });
    expect(blocked.components.voteDemand).toBe(none.components.voteDemand);
    expect(blocked.components.useCaseEvidence).toBe(
      none.components.useCaseEvidence,
    );
    expect(blocked.components.workaroundBurden).toBeGreaterThan(
      none.components.workaroundBurden,
    );
    expect(blocked.components.composite).toBeGreaterThan(
      none.components.composite,
    );
  });

  it('lets diverse evidence outrank a vote-only signal', () => {
    const voteOnly = calculateScore({
      votes: 120,
      qualifiedComments: [],
    });
    const evidenceRich = calculateScore({
      votes: 55,
      qualifiedComments: Array.from({ length: 14 }, (_, index) =>
        comment(`author-${index}`, index % 3, 'high'),
      ),
    });
    expect(evidenceRich.components.composite).toBeGreaterThan(
      voteOnly.components.composite,
    );
  });
});
