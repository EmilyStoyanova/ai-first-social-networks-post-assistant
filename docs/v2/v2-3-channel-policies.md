# v2-3 — Channel Policy Model

## Goal

Replace the ad-hoc platform claims scattered in `CHANNEL_RULES` (`lib/ai/prompt-builder.ts`) with a typed, maintainable policy model that distinguishes verified constraints from best-practice recommendations.

## No Schema Changes

This phase is code-only. No migrations.

## Policy Model

### New file: `lib/ai/channel-policy.ts`

```typescript
export type PolicySeverity = "BLOCKING" | "WARNING" | "SUGGESTION";

export interface PlatformConstraint {
  /** BLOCKING = verified API/platform behaviour that will cause a publish failure. */
  severity: "BLOCKING";
  id: string;
  description: string;
  check: (post: PostForPolicyCheck) => boolean; // true = constraint violated
}

export interface GenerationHint {
  /** WARNING = strong recommendation; SUGGESTION = light best-practice tip. */
  severity: "WARNING" | "SUGGESTION";
  id: string;
  description: string;
  promptFragment: string; // injected into system prompt when this hint applies
}

export type ChannelPolicy = {
  constraints: PlatformConstraint[];
  hints: GenerationHint[];
};

export const CHANNEL_POLICIES: Record<SocialChannel, ChannelPolicy> = {
  instagram: {
    constraints: [
      {
        severity: "BLOCKING",
        id: "instagram_requires_media",
        description: "Instagram posts require at least one image or video.",
        check: (post) => !post.mediaAssetId,
      },
    ],
    hints: [
      {
        severity: "WARNING",
        id: "instagram_hashtag_count",
        description: "Instagram engagement typically benefits from relevant hashtags.",
        promptFragment: "Include 5–10 relevant hashtags appropriate for the content.",
      },
      // ... additional hints
    ],
  },
  // facebook, linkedin, tiktok ...
};
```

**Severity semantics:**

- `BLOCKING` — verified by Buffer API behaviour or official platform documentation. Prevents publish.
- `WARNING` — informed recommendation. Surfaced in UI; included in system prompt. Does not block.
- `SUGGESTION` — light tip. Included in system prompt only; not surfaced prominently in UI.

**Rule:** Do not claim specific algorithm ranking effects as fact. Use hedged language: "typically", "may improve", "recommended practice". Never state "increases reach by X%".

## Service Changes

### `lib/ai/prompt-builder.ts`

- Remove hardcoded `CHANNEL_RULES` string map.
- Replace with: collect `hints` from `CHANNEL_POLICIES[channel]`, build `promptFragment` list.
- System prompt injects hint fragments (WARNING + SUGGESTION) as a block.

```typescript
function buildChannelHintBlock(channel: SocialChannel): string {
  const { hints } = CHANNEL_POLICIES[channel];
  const fragments = hints.map((h) => `- ${h.promptFragment}`);
  return fragments.length > 0
    ? `Platform best practices for ${channel}:\n${fragments.join("\n")}`
    : "";
}
```

### `lib/services/posts/publish-post.service.ts`

Before sending to Buffer, run BLOCKING constraints:

```typescript
function checkBlockingConstraints(post: PostForPolicyCheck): PlatformConstraint[] {
  const { constraints } = CHANNEL_POLICIES[post.channel];
  return constraints.filter((c) => c.severity === "BLOCKING" && c.check(post));
}

// In publish flow:
const violations = checkBlockingConstraints(post);
if (violations.length > 0) {
  return {
    success: false,
    code: "POLICY_VIOLATION",
    violations: violations.map((v) => ({ id: v.id, description: v.description })),
  };
}
```

## Initial Policy Definitions

| Channel   | Constraint (BLOCKING) | Hints (WARNING/SUGGESTION)                  |
| --------- | --------------------- | ------------------------------------------- |
| Instagram | Requires media        | Hashtags 5–10; CTA in first line            |
| LinkedIn  | None verified         | Professional tone; avoid hard sell          |
| Facebook  | None verified         | Keep under 80 chars for link previews       |
| TikTok    | Requires video        | Trending audio mention; hook in first 3 sec |

Only add BLOCKING constraints you can verify against the Buffer API or official platform docs.

## Acceptance Criteria

- [ ] `CHANNEL_POLICIES` is the single source of truth for all channel-specific claims
- [ ] No platform claims remain in `prompt-builder.ts`, `CHANNEL_RULES`, or any service outside `channel-policy.ts`
- [ ] Instagram post without `mediaAssetId` → `POLICY_VIOLATION` returned; Buffer not called
- [ ] TikTok BLOCKING constraint for video documented with source reference
- [ ] WARNING hints appear in system prompt; BLOCKING constraints do not add prompt fragments (they block instead)
- [ ] SUGGESTION hints appear in system prompt only; not surfaced as UI warnings
- [ ] `npm run typecheck && npm run lint` clean

## Edge Cases

- A channel with no BLOCKING constraints: `constraints = []`, publish proceeds normally
- Unknown channel in `CHANNEL_POLICIES`: TypeScript exhaustive check catches at compile time
- New platform constraint: add to `CHANNEL_POLICIES`, propagates automatically to both publish check and prompt generation
