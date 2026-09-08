import { describe, expect, it } from 'vitest';
import {
  deduplicateQualifiedAuthors,
  qualifyComment,
} from '../src/lib/signals/qualification';
import type { RawComment } from '../src/lib/signals/model';

function raw(overrides: Partial<RawComment> = {}): RawComment {
  return {
    id: '1',
    author: 'developer',
    sourceUrl: 'https://github.com/web-platform-dx/developer-signals/issues/1',
    createdAt: '2026-09-08T10:00:00.000Z',
    body: '',
    positiveReactions: 0,
    ...overrides,
  };
}

describe('qualification', () => {
  it('qualifies a concrete structured use case and workaround', () => {
    const result = qualifyComment(
      raw({
        body: `## What I want to do with this feature
Our design system team needs to build anchored menus that remain visible while users scroll nested components.

## What I'm having to do in the meantime
We maintain a custom JavaScript implementation with observers and manual calculation.`,
      }),
    );
    expect(result.classification).toBe('qualified');
    expect(result.parsedGoal).toContain('anchored menus');
    expect(result.workaroundSeverity).toBe('moderate');
  });

  it.each([
    ['bot', raw({ author: 'dependabot[bot]', body: 'A sufficiently long update.' })],
    ['template-only', raw({ body: '## What I want to do with this feature\nDescribe your use case' })],
    ['generic-support', raw({ body: '+1' })],
    [
      'moderation',
      raw({
        authorAssociation: 'MEMBER',
        body: 'Closing this as a duplicate of another issue.',
      }),
    ],
    [
      'debate-only',
      raw({
        body: 'Browser vendors should change the standards process. I disagree with this direction.',
      }),
    ],
  ])('excludes %s comments', (reason, comment) => {
    expect(qualifyComment(comment).exclusionReason).toBe(reason);
  });

  it('keeps only the strongest qualified comment per author', () => {
    const comments = deduplicateQualifiedAuthors([
      qualifyComment(
        raw({
          id: 'first',
          body: 'Our app team needs to build responsive menus for users and currently uses an extra CSS fallback.',
        }),
      ),
      qualifyComment(
        raw({
          id: 'second',
          positiveReactions: 4,
          body: 'Our app team needs to build responsive menus for users, but we are blocked because there is no viable fallback.',
        }),
      ),
    ]);
    expect(
      comments.find((comment) => comment.id === 'second')?.classification,
    ).toBe('qualified');
    expect(
      comments.find((comment) => comment.id === 'first')?.exclusionReason,
    ).toBe('duplicate-author');
  });

  it('applies a manual override last', () => {
    const result = qualifyComment(raw({ body: '+1' }), {
      sourceId: '1',
      classification: 'qualified',
      parsedGoal: 'Our team needs to build a documented scenario for users.',
      rationale: 'Reviewer confirmed context in linked code.',
      reviewer: 'maintainer',
      reviewedAt: '2026-09-08',
    });
    expect(result.classification).toBe('qualified');
    expect(result.exclusionReason).toBeUndefined();
  });

  it('does not treat a limited package as a completely blocked use case', () => {
    const result = qualifyComment(
      raw({
        body: `## What I want to do with this feature
Our CMS team needs to build masonry layouts without changing generated markup.

## What I'm having to do in the meantime
We use a JavaScript package, but its required CSS classes make it impossible to use in some cases and increase bundle size.`,
      }),
    );
    expect(result.workaroundSeverity).toBe('high');
  });

  it('recognizes verbose legacy implementations as a workaround', () => {
    const result = qualifyComment(
      raw({
        body: `## What I want to do with this feature
Our dashboard needs to build a dense layout for analysis panels of different heights.

## What I'm having to do in the meantime
We rely on older implementations, which makes our CSS unnecessarily verbose.`,
      }),
    );
    expect(result.workaroundSeverity).toBe('moderate');
  });
});
