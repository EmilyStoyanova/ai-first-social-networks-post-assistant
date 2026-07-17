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
