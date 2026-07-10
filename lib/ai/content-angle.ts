export const CONTENT_ANGLES = [
  "Educational",
  "Tips & Tricks",
  "Common Mistakes",
  "Myth vs Fact",
  "FAQ",
  "Customer Story",
  "Case Study",
  "Behind the Scenes",
  "ROI / Business Impact",
  "Industry Trend",
  "Checklist",
  "Inspirational",
  "Product Feature",
  "Problem → Solution",
  "Comparison",
] as const;

export type ContentAngle = (typeof CONTENT_ANGLES)[number];

export const ANGLE_INSTRUCTIONS: Record<ContentAngle, string> = {
  Educational: "Teach the audience one specific thing they did not know. Lead with the insight.",
  "Tips & Tricks": "Share 2–4 immediately actionable tips the reader can apply today.",
  "Common Mistakes": "Name one mistake people make and explain clearly what to do instead.",
  "Myth vs Fact": "Open by debunking a common misconception about the topic.",
  FAQ: "Answer one question the audience is already asking about the topic.",
  "Customer Story": "Illustrate the topic through a relatable user or customer experience.",
  "Case Study": "Describe a concrete before/after situation with a measurable result.",
  "Behind the Scenes": "Give a peek into how things work internally — process, team, or craft.",
  "ROI / Business Impact": "Lead with a number, metric, or measurable business outcome.",
  "Industry Trend": "Frame the topic as part of a larger shift or movement happening now.",
  Checklist: "Give a scannable step-by-step list the reader can act on immediately.",
  Inspirational: "Motivate and energise. Lead with an insight that shifts perspective.",
  "Product Feature": "Highlight one specific capability and the problem it solves.",
  "Problem → Solution": "Open by naming a pain point, then show exactly how it is solved.",
  Comparison: "Put two approaches, options, or eras side by side to surface a clear insight.",
};

/**
 * Picks the least recently used angle from CONTENT_ANGLES.
 * recentAngles is ordered most-recent-first; angles absent from the list are
 * treated as oldest and receive priority.
 */
export function selectAngle(recentAngles: readonly ContentAngle[]): ContentAngle {
  for (const angle of CONTENT_ANGLES) {
    if (!recentAngles.includes(angle)) return angle;
  }
  // Every angle has been used — pick the one deepest in the recents list (least recent).
  let best: ContentAngle = CONTENT_ANGLES[0];
  let bestIdx = recentAngles.indexOf(CONTENT_ANGLES[0]);
  for (let i = 1; i < CONTENT_ANGLES.length; i++) {
    const idx = recentAngles.indexOf(CONTENT_ANGLES[i]);
    if (idx > bestIdx) {
      bestIdx = idx;
      best = CONTENT_ANGLES[i];
    }
  }
  return best;
}

/**
 * Picks an angle for a retry attempt.
 * Never returns currentAngle. Prefers angles absent from recentAngles.
 * Falls back to the least recently used non-current angle when all are present.
 */
export function selectRetryAngle(
  currentAngle: ContentAngle,
  recentAngles: readonly ContentAngle[]
): ContentAngle {
  for (const angle of CONTENT_ANGLES) {
    if (angle !== currentAngle && !recentAngles.includes(angle)) return angle;
  }
  let best: ContentAngle | null = null;
  let bestIdx = -1;
  for (const angle of CONTENT_ANGLES) {
    if (angle === currentAngle) continue;
    const idx = recentAngles.indexOf(angle);
    if (idx > bestIdx) {
      bestIdx = idx;
      best = angle;
    }
  }
  // At least one non-current angle always exists (CONTENT_ANGLES has 15 entries).
  return best!;
}
