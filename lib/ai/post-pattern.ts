// ─── Hook types ───────────────────────────────────────────────────────────────

export const HOOK_TYPES = [
  "Question",
  "Statistic",
  "Bold Statement",
  "Story Opening",
  "Pain Point",
  "Contrast",
  "Imperative",
  "Empathy",
] as const;

export type HookType = (typeof HOOK_TYPES)[number];

// ─── Post structures ──────────────────────────────────────────────────────────

export const POST_STRUCTURES = [
  "Single Insight",
  "List",
  "Before / After",
  "Problem → Solution",
  "Story Arc",
  "Data → Insight",
  "How-To Steps",
] as const;

export type PostStructure = (typeof POST_STRUCTURES)[number];

// ─── CTA types ────────────────────────────────────────────────────────────────

export const CTA_TYPES = [
  "Comment Prompt",
  "Website Visit",
  "Reflection",
  "Try It",
  "Share",
  "Follow",
  "Open Question",
  "No CTA",
] as const;

export type CtaType = (typeof CTA_TYPES)[number];

// ─── Combined pattern ─────────────────────────────────────────────────────────

export interface PostPattern {
  hookType: HookType;
  structure: PostStructure;
  ctaType: CtaType;
}

// ─── Prompt instructions ──────────────────────────────────────────────────────

export const HOOK_INSTRUCTIONS: Record<HookType, string> = {
  Question: 'Open with a direct question to the reader. E.g. "Have you ever...?", "What if...?"',
  Statistic: 'Open with a specific number or data point. E.g. "X% of...", "In 2025..."',
  "Bold Statement":
    "Open with a confident, counterintuitive claim that challenges the reader's assumption.",
  "Story Opening": "Open by dropping the reader into a brief real scenario or situation.",
  "Pain Point": "Open by naming a frustration or struggle the audience recognises immediately.",
  Contrast: 'Open with a contrast. E.g. "Most businesses do X — the successful ones do Y."',
  Imperative: 'Open with a direct command. E.g. "Stop doing X." or "It\'s time to rethink..."',
  Empathy:
    "Open by acknowledging the reader's situation or feelings before pivoting to the insight.",
};

export const STRUCTURE_INSTRUCTIONS: Record<PostStructure, string> = {
  "Single Insight": "Develop exactly one key idea in full. Do NOT use a list or numbered items.",
  List: "Present 3–5 points in a numbered or bulleted, scannable format.",
  "Before / After":
    "Contrast two states: how things looked before and after the insight or change.",
  "Problem → Solution": "State the problem clearly first, then provide the resolution.",
  "Story Arc": "Follow a simple narrative: setup, conflict or challenge, resolution or lesson.",
  "Data → Insight": "Lead with evidence or a finding, then explain what it means for the reader.",
  "How-To Steps": "Walk through 2–4 actionable steps the reader can follow in sequence.",
};

export const CTA_INSTRUCTIONS: Record<CtaType, string> = {
  "Comment Prompt": 'Invite engagement. E.g. "What\'s your take?", "Drop your answer below."',
  "Website Visit": "End with a prompt to visit a link or website for more information.",
  Reflection:
    "Close with a question or prompt that invites the reader to reflect on their own situation.",
  "Try It":
    'Challenge the reader to take an immediate small action. E.g. "Try this today:", "Test it this week."',
  Share: "Invite the reader to share this post with someone who would benefit from it.",
  Follow: "Invite the reader to follow the account or connect for more content.",
  "Open Question":
    "End on an open-ended question that naturally invites responses without explicitly saying 'comment'.",
  "No CTA": "Do not include a call to action. Let the content speak for itself.",
};

// ─── Selection helpers ────────────────────────────────────────────────────────

function selectLru<T extends string>(items: readonly T[], recentItems: readonly T[]): T {
  for (const item of items) {
    if (!recentItems.includes(item)) return item;
  }
  let best: T = items[0];
  let bestIdx = recentItems.indexOf(items[0]);
  for (let i = 1; i < items.length; i++) {
    const idx = recentItems.indexOf(items[i]);
    if (idx > bestIdx) {
      bestIdx = idx;
      best = items[i];
    }
  }
  return best;
}

function selectLruExcluding<T extends string>(
  current: T,
  items: readonly T[],
  recentItems: readonly T[]
): T {
  for (const item of items) {
    if (item !== current && !recentItems.includes(item)) return item;
  }
  let best: T | null = null;
  let bestIdx = -1;
  for (const item of items) {
    if (item === current) continue;
    const idx = recentItems.indexOf(item);
    if (idx > bestIdx) {
      bestIdx = idx;
      best = item;
    }
  }
  return best!;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Picks the least recently used value for each dimension independently.
 * recentPatterns is ordered most-recent-first.
 */
export function selectPattern(recentPatterns: readonly PostPattern[]): PostPattern {
  return {
    hookType: selectLru(
      HOOK_TYPES,
      recentPatterns.map((p) => p.hookType)
    ),
    structure: selectLru(
      POST_STRUCTURES,
      recentPatterns.map((p) => p.structure)
    ),
    ctaType: selectLru(
      CTA_TYPES,
      recentPatterns.map((p) => p.ctaType)
    ),
  };
}

/**
 * Picks a pattern for a retry attempt.
 * Every dimension in the result differs from the corresponding value in current.
 * Prefers values absent from recentPatterns.
 */
export function selectRetryPattern(
  current: PostPattern,
  recentPatterns: readonly PostPattern[]
): PostPattern {
  return {
    hookType: selectLruExcluding(
      current.hookType,
      HOOK_TYPES,
      recentPatterns.map((p) => p.hookType)
    ),
    structure: selectLruExcluding(
      current.structure,
      POST_STRUCTURES,
      recentPatterns.map((p) => p.structure)
    ),
    ctaType: selectLruExcluding(
      current.ctaType,
      CTA_TYPES,
      recentPatterns.map((p) => p.ctaType)
    ),
  };
}

/**
 * Type guard for validating a value parsed from JSON (e.g. promptSnapshot).
 */
export function isValidPostPattern(value: unknown): value is PostPattern {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (HOOK_TYPES as readonly string[]).includes(v.hookType as string) &&
    (POST_STRUCTURES as readonly string[]).includes(v.structure as string) &&
    (CTA_TYPES as readonly string[]).includes(v.ctaType as string)
  );
}
