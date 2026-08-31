import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SocialChannel } from "@prisma/client";
import {
  CHANNEL_POLICIES,
  checkBlockingConstraints,
  getChannelPolicy,
  type PostForPolicyCheck,
} from "./channel-policy";

const ALL_CHANNELS: SocialChannel[] = ["facebook", "linkedin", "instagram", "tiktok"];

function post(overrides: Partial<PostForPolicyCheck> = {}): PostForPolicyCheck {
  return { channel: "instagram", mediaAssetId: null, ...overrides };
}

describe("channel-policy — coverage", () => {
  it("defines a policy for every SocialChannel", () => {
    for (const channel of ALL_CHANNELS) {
      assert.ok(CHANNEL_POLICIES[channel], `missing policy for ${channel}`);
    }
    assert.equal(Object.keys(CHANNEL_POLICIES).length, ALL_CHANNELS.length);
  });

  it("getChannelPolicy returns null for a channel outside the enum", () => {
    assert.equal(getChannelPolicy("myspace"), null);
  });

  it("policy ids are unique across the whole model", () => {
    const ids = ALL_CHANNELS.flatMap((c) => [
      ...CHANNEL_POLICIES[c].constraints.map((x) => x.id),
      ...CHANNEL_POLICIES[c].hints.map((x) => x.id),
    ]);
    assert.equal(new Set(ids).size, ids.length, "duplicate policy id");
  });
});

describe("channel-policy — severity invariants", () => {
  it("every constraint is BLOCKING and cites a source", () => {
    for (const channel of ALL_CHANNELS) {
      for (const c of CHANNEL_POLICIES[channel].constraints) {
        assert.equal(c.severity, "BLOCKING", `${c.id} must be BLOCKING`);
        assert.ok(c.source.trim().length > 0, `${c.id} must cite a verification source`);
        assert.ok(c.description.trim().length > 0, `${c.id} must have a description`);
      }
    }
  });

  it("hints are only WARNING or SUGGESTION — a hint can never block", () => {
    for (const channel of ALL_CHANNELS) {
      for (const h of CHANNEL_POLICIES[channel].hints) {
        assert.ok(
          h.severity === "WARNING" || h.severity === "SUGGESTION",
          `${h.id} has invalid hint severity ${h.severity}`
        );
        assert.ok(h.promptFragment.trim().length > 0, `${h.id} must have a prompt fragment`);
      }
    }
  });

  it("hint wording stays hedged — no fabricated ranking/reach claims", () => {
    // Guards the policy rule: never state algorithm effects as fact.
    const forbidden = /\d+\s*%|increases? (reach|engagement) by|guarantee|will boost|\bproven\b/i;
    for (const channel of ALL_CHANNELS) {
      for (const h of CHANNEL_POLICIES[channel].hints) {
        assert.ok(
          !forbidden.test(h.description),
          `${h.id} description makes an unhedged claim: ${h.description}`
        );
      }
    }
  });
});

describe("channel-policy — Instagram requires media", () => {
  it("blocks an Instagram post with no media", () => {
    const violations = checkBlockingConstraints(post({ channel: "instagram", mediaAssetId: null }));
    assert.equal(violations.length, 1);
    assert.equal(violations[0].id, "instagram_requires_media");
    assert.match(violations[0].description, /image or video/i);
  });

  it("allows an Instagram post that has media", () => {
    const violations = checkBlockingConstraints(
      post({ channel: "instagram", mediaAssetId: "media-1" })
    );
    assert.deepEqual(violations, []);
  });
});

describe("channel-policy — TikTok requires media", () => {
  it("blocks a TikTok post with no media", () => {
    const violations = checkBlockingConstraints(post({ channel: "tiktok", mediaAssetId: null }));
    assert.equal(violations.length, 1);
    assert.equal(violations[0].id, "tiktok_requires_media");
  });

  it("allows a TikTok post that has media", () => {
    const violations = checkBlockingConstraints(post({ channel: "tiktok", mediaAssetId: "m" }));
    assert.deepEqual(violations, []);
  });

  it("does not claim video — the app cannot verify media type", () => {
    const [constraint] = CHANNEL_POLICIES.tiktok.constraints;
    assert.ok(
      !/\bvideo\b/i.test(constraint.description),
      "TikTok constraint must not assert a video requirement it cannot check"
    );
  });
});

describe("channel-policy — channels with no verified constraints", () => {
  for (const channel of ["facebook", "linkedin"] as const) {
    it(`${channel} has no BLOCKING constraints and never blocks publishing`, () => {
      assert.deepEqual(CHANNEL_POLICIES[channel].constraints, []);
      assert.deepEqual(checkBlockingConstraints(post({ channel, mediaAssetId: null })), []);
      assert.deepEqual(checkBlockingConstraints(post({ channel, mediaAssetId: "m" })), []);
    });
  }

  it("an unknown channel does not block (no policy = no verified constraint)", () => {
    const violations = checkBlockingConstraints({
      channel: "myspace" as SocialChannel,
      mediaAssetId: null,
    });
    assert.deepEqual(violations, []);
  });
});

describe("channel-policy — Facebook writing principles", () => {
  it("Facebook policy includes guidance for first-line hooks", () => {
    const policy = CHANNEL_POLICIES.facebook;
    const hookHint = policy.hints.find((h) => h.id === "facebook_first_line_hook");
    assert.ok(hookHint, "Facebook policy should include first-line hook guidance");
    assert.match(
      hookHint.promptFragment,
      /(?:opening|first).*(?:1.{0,5}2|1–2).*lines/i,
      "hook hint should mention the critical first 1–2 lines"
    );
  });

  it("Facebook policy includes guidance for mobile formatting", () => {
    const policy = CHANNEL_POLICIES.facebook;
    const formatHint = policy.hints.find((h) => h.id === "facebook_mobile_formatting");
    assert.ok(formatHint, "Facebook policy should include mobile formatting guidance");
    assert.match(formatHint.promptFragment, /short\s+paragraphs|mobile/i);
  });

  it("Facebook policy emphasizes single main idea focus", () => {
    const policy = CHANNEL_POLICIES.facebook;
    const oneIdeaHint = policy.hints.find((h) => h.id === "facebook_one_idea");
    assert.ok(oneIdeaHint, "Facebook policy should emphasize one main idea");
    assert.match(oneIdeaHint.promptFragment, /one.*main.*idea|single/i);
  });

  it("Facebook policy includes conversational tone guidance", () => {
    const policy = CHANNEL_POLICIES.facebook;
    const toneHint = policy.hints.find((h) => h.id === "facebook_conversational_tone");
    assert.ok(toneHint, "Facebook policy should include conversational tone guidance");
    assert.match(toneHint.promptFragment, /conversational|authentic/i);
  });

  it("Facebook policy includes audience value emphasis", () => {
    const policy = CHANNEL_POLICIES.facebook;
    const valueHint = policy.hints.find((h) => h.id === "facebook_audience_value");
    assert.ok(valueHint, "Facebook policy should emphasize audience value");
    assert.match(valueHint.promptFragment, /why.*matters|benefit|value/i);
  });

  it("Facebook policy includes meaningful CTA guidance", () => {
    const policy = CHANNEL_POLICIES.facebook;
    const ctaHint = policy.hints.find((h) => h.id === "facebook_cta_meaningful");
    assert.ok(ctaHint, "Facebook policy should include meaningful CTA guidance");
    assert.match(ctaHint.promptFragment, /meaningful|relevant|call to action/i);
  });

  it("Facebook policy includes moderate emoji usage guidance", () => {
    const policy = CHANNEL_POLICIES.facebook;
    const emojiHint = policy.hints.find((h) => h.id === "facebook_emoji_use");
    assert.ok(emojiHint, "Facebook policy should include emoji guidance");
    assert.match(emojiHint.promptFragment, /moderate|0.{0,5}2/i);
  });

  it("Facebook policy advises against template-like writing", () => {
    const policy = CHANNEL_POLICIES.facebook;
    const templateHint = policy.hints.find((h) => h.id === "facebook_avoid_template_writing");
    assert.ok(templateHint, "Facebook policy should warn against template-like writing");
    assert.match(templateHint.promptFragment, /template|formulaic|coherent/i);
  });

  // The assigned hook archetype is the ONLY thing allowed to name a hook style.
  // Channel guidance that also recommended "a direct question" competed with it
  // on every single post, and won — eleven of twenty consecutive posts opened
  // with the same rhetorical question under eight different assigned archetypes.
  it("Facebook first-line guidance recommends no hook archetype of its own", () => {
    const hookHint = CHANNEL_POLICIES.facebook.hints.find(
      (h) => h.id === "facebook_first_line_hook"
    );
    assert.ok(hookHint);
    assert.doesNotMatch(
      hookHint.promptFragment,
      /start with a (?:strong hook: )?(?:a )?direct question|with a direct question/i,
      "first-line guidance must not independently recommend a question opening"
    );
  });

  it("Facebook first-line guidance defers to the assigned hook style", () => {
    const hookHint = CHANNEL_POLICIES.facebook.hints.find(
      (h) => h.id === "facebook_first_line_hook"
    );
    assert.ok(hookHint);
    assert.match(hookHint.promptFragment, /hook style assigned/i);
  });

  it("no Facebook hint pushes every post toward a rhetorical question", () => {
    for (const hint of CHANNEL_POLICIES.facebook.hints) {
      assert.doesNotMatch(
        hint.promptFragment,
        /\bstart with .{0,40}\bquestion\b|\bopen with .{0,40}\bquestion\b/i,
        `Facebook hint ${hint.id} must not prescribe a question opening`
      );
    }
  });

  it("conversational tone guidance does not imply asking a question", () => {
    const toneHint = CHANNEL_POLICIES.facebook.hints.find(
      (h) => h.id === "facebook_conversational_tone"
    );
    assert.ok(toneHint);
    assert.match(toneHint.promptFragment, /does NOT mean the post has to ask/i);
  });

  it("all Facebook hints have non-empty prompt fragments", () => {
    const policy = CHANNEL_POLICIES.facebook;
    for (const hint of policy.hints) {
      assert.ok(
        hint.promptFragment.trim().length > 0,
        `Facebook hint ${hint.id} must have a non-empty prompt fragment`
      );
    }
  });
});
