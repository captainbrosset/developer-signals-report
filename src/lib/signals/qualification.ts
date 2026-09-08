import type {
  CommentSignal,
  ManualOverride,
  RawComment,
  WorkaroundSeverity,
} from './model';

const BOT_PATTERN =
  /(?:\[bot\]$|dependabot|renovate|github-actions|web-platform-dx-bot)/i;
const MODERATION_PATTERN =
  /(?:duplicate of|closing this|off[- ]topic|please keep|moderation|thread locked|removed as|housekeeping)/i;
const GENERIC_SUPPORT_PATTERN =
  /^(?:\+1|👍|same|agreed?|support(?: this)?|please implement|would love this|need this)[.! ]*$/i;
const DEBATE_PATTERN =
  /(?:the spec should|browser vendors? should|i disagree|not convinced|this is a bad idea|standards process)/i;
const PLACEHOLDER_PATTERN =
  /(?:describe (?:your|the)|add (?:details|a description)|n\/a|none yet|todo|<!--[\s\S]*?-->)/gi;
const GOAL_HEADING =
  /(?:^|\n)#{1,6}\s*(?:what i want to do with this feature|use case|goal|what i(?:'|’)m trying to do)\s*:?\s*\n/i;
const WORKAROUND_HEADING =
  /(?:^|\n)#{1,6}\s*(?:what i(?:'|’)m having to do in the meantime|workaround|fallback|in the meantime)\s*:?\s*\n/i;

export function qualifyComment(
  raw: RawComment,
  override?: ManualOverride,
): CommentSignal {
  const parsed = parseTemplateSections(raw.body);
  const cleaned = cleanMarkdown(raw.body);
  let classification: CommentSignal['classification'] = 'ambiguous';
  let exclusionReason: CommentSignal['exclusionReason'];

  if (BOT_PATTERN.test(raw.author)) {
    classification = 'excluded';
    exclusionReason = 'bot';
  } else if (raw.minimized) {
    classification = 'excluded';
    exclusionReason = 'minimized';
  } else if (
    ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(
      raw.authorAssociation?.toUpperCase() ?? '',
    ) &&
    MODERATION_PATTERN.test(cleaned)
  ) {
    classification = 'excluded';
    exclusionReason = 'moderation';
  } else if (GENERIC_SUPPORT_PATTERN.test(cleaned)) {
    classification = 'excluded';
    exclusionReason = 'generic-support';
  } else if (!cleaned || isTemplateOnly(raw.body)) {
    classification = 'excluded';
    exclusionReason = 'template-only';
  } else if (
    DEBATE_PATTERN.test(cleaned) &&
    !hasConcreteScenario(parsed.goal || cleaned)
  ) {
    classification = 'excluded';
    exclusionReason = 'debate-only';
  } else if (hasConcreteScenario(parsed.goal || cleaned)) {
    classification = 'qualified';
  } else {
    classification = 'excluded';
    exclusionReason = 'insufficient-specificity';
  }

  const workaroundText = parsed.workaround || cleaned;
  const result: CommentSignal = {
    id: raw.id,
    author: raw.author,
    authorAssociation: raw.authorAssociation,
    sourceUrl: raw.sourceUrl,
    createdAt: raw.createdAt,
    body: raw.body,
    parsedGoal: parsed.goal || undefined,
    parsedWorkaround: parsed.workaround || undefined,
    positiveReactions: raw.positiveReactions,
    classification,
    exclusionReason,
    themes: inferThemes(parsed.goal || cleaned),
    workaroundSeverity: classifyWorkaround(workaroundText),
    generatedSummary:
      classification === 'qualified'
        ? excerpt(parsed.goal || cleaned, 180)
        : undefined,
    summaryKind:
      classification === 'qualified' ? 'source-excerpt' : undefined,
  };

  return applyOverride(result, override);
}

export function deduplicateQualifiedAuthors(
  comments: CommentSignal[],
): CommentSignal[] {
  const strongestByAuthor = new Map<string, CommentSignal>();
  for (const comment of comments.filter(
    (item) => item.classification === 'qualified',
  )) {
    const author = comment.author.toLowerCase();
    const previous = strongestByAuthor.get(author);
    if (!previous || commentStrength(comment) > commentStrength(previous)) {
      strongestByAuthor.set(author, comment);
    }
  }

  return comments.map((comment) => {
    if (comment.classification !== 'qualified') return comment;
    if (strongestByAuthor.get(comment.author.toLowerCase())?.id === comment.id) {
      return comment;
    }
    return {
      ...comment,
      classification: 'excluded',
      exclusionReason: 'duplicate-author',
    };
  });
}

export function parseTemplateSections(body: string): {
  goal: string;
  workaround: string;
} {
  const goalMatch = GOAL_HEADING.exec(body);
  const workaroundMatch = WORKAROUND_HEADING.exec(body);
  let goal = '';
  let workaround = '';

  if (goalMatch) {
    const start = goalMatch.index + goalMatch[0].length;
    const end =
      workaroundMatch && workaroundMatch.index > goalMatch.index
        ? workaroundMatch.index
        : body.length;
    goal = cleanMarkdown(body.slice(start, end));
  }
  if (workaroundMatch) {
    const start = workaroundMatch.index + workaroundMatch[0].length;
    workaround = cleanMarkdown(body.slice(start));
  }
  return { goal, workaround };
}

export function classifyWorkaround(text: string): WorkaroundSeverity {
  if (
    /(?:\bblocked\b|cannot ship|no viable (?:fallback|workaround)|impossible to (?:ship|implement|achieve)|must disable)/i.test(
      text,
    )
  ) {
    return 'blocked';
  }
  if (
    /(?:maintain (?:two|multiple)|duplicate implementation|server[- ]side render|large polyfill|extra (?:bundle|payload)|increase bundle size|degraded experience|javascript package|dependency graph)/i.test(
      text,
    )
  ) {
    return 'high';
  }
  if (
    /(?:polyfill|javascript fallback|feature detection|custom implementation|additional request|manual calculation|older implementations|unnecessarily verbose)/i.test(
      text,
    )
  ) {
    return 'moderate';
  }
  if (/(?:fallback|extra css|small helper|progressive enhancement)/i.test(text)) {
    return 'light';
  }
  return 'none';
}

function hasConcreteScenario(text: string): boolean {
  if (text.length < 36) return false;
  const context =
    /(?:\b(?:i|we|my|our|team|users?|customers?|app|site|component|design system|editor|dashboard|store)\b)/i.test(
      text,
    );
  const action =
    /(?:build|render|style|display|animate|position|parse|schedule|select|upload|edit|navigate|authenticate|calculate|layout|decode|stream|sanitize|query|support|deliver)/i.test(
      text,
    );
  return context && action;
}

function isTemplateOnly(body: string): boolean {
  const withoutHeadings = body
    .replace(GOAL_HEADING, '')
    .replace(WORKAROUND_HEADING, '')
    .replace(PLACEHOLDER_PATTERN, '')
    .replace(/[#>*_`\-\s]/g, '');
  return withoutHeadings.length < 12;
}

function cleanMarkdown(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, ' code sample ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferThemes(text: string): string[] {
  const themes: string[] = [];
  const mappings: [RegExp, string][] = [
    [/(?:accessib|screen reader|keyboard|assistive)/i, 'accessibility'],
    [/(?:performance|payload|bundle|latency|smooth)/i, 'performance'],
    [/(?:layout|grid|position|responsive|style)/i, 'layout & design'],
    [/(?:date|time|calendar|timezone|schedule)/i, 'date & time'],
    [/(?:image|video|audio|media|codec)/i, 'media'],
    [/(?:security|sanitize|xss|trusted)/i, 'security'],
    [/(?:pwa|install|offline|native app)/i, 'installed apps'],
  ];
  for (const [pattern, label] of mappings) {
    if (pattern.test(text)) themes.push(label);
  }
  return themes.length ? themes : ['developer experience'];
}

function commentStrength(comment: CommentSignal): number {
  const severity = {
    none: 0,
    light: 1,
    moderate: 2,
    high: 3,
    blocked: 4,
  }[comment.workaroundSeverity];
  return (
    severity * 1000 +
    Math.min(comment.positiveReactions, 50) * 10 +
    (comment.parsedGoal?.length ?? comment.body.length)
  );
}

function applyOverride(
  comment: CommentSignal,
  override?: ManualOverride,
): CommentSignal {
  if (!override) return comment;
  return {
    ...comment,
    classification: override.classification ?? comment.classification,
    exclusionReason:
      override.classification === 'qualified'
        ? undefined
        : (override.exclusionReason ?? comment.exclusionReason),
    parsedGoal: override.parsedGoal ?? comment.parsedGoal,
    parsedWorkaround:
      override.parsedWorkaround ?? comment.parsedWorkaround,
    workaroundSeverity:
      override.workaroundSeverity ?? comment.workaroundSeverity,
    themes: override.themes ?? comment.themes,
    generatedSummary:
      override.generatedSummary ?? comment.generatedSummary,
    summaryKind: override.summaryKind ?? comment.summaryKind,
  };
}

function excerpt(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
