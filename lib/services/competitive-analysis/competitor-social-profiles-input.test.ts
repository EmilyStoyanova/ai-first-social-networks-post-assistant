import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toCompetitorSocialProfileCreateInput } from "./competitor-social-profiles-input";
import type { CompetitorSocialProfileInput } from "@/lib/validators/competitor.schema";

describe("toCompetitorSocialProfileCreateInput", () => {
  it("returns [] for undefined or empty input", () => {
    assert.deepEqual(toCompetitorSocialProfileCreateInput(undefined), []);
    assert.deepEqual(toCompetitorSocialProfileCreateInput([]), []);
  });

  it("supports multiple profiles on the SAME platform — no dedupe by platform (§3.4)", () => {
    const input: CompetitorSocialProfileInput[] = [
      { platform: "facebook", url: "https://facebook.com/acme-us", label: "US page" },
      { platform: "facebook", url: "https://facebook.com/acme-eu", label: "EU page" },
    ];
    const result = toCompetitorSocialProfileCreateInput(input);
    assert.equal(result.length, 2);
    assert.equal(result[0].url, "https://facebook.com/acme-us");
    assert.equal(result[1].url, "https://facebook.com/acme-eu");
    assert.equal(result[0].platform, "facebook");
    assert.equal(result[1].platform, "facebook");
  });

  it("normalizes an absent/empty label to null", () => {
    const input: CompetitorSocialProfileInput[] = [{ platform: "x", url: "https://x.com/acme" }];
    const result = toCompetitorSocialProfileCreateInput(input);
    assert.equal(result[0].label, null);
  });

  it("preserves a provided label", () => {
    const input: CompetitorSocialProfileInput[] = [
      { platform: "linkedin", url: "https://linkedin.com/company/acme", label: "Company page" },
    ];
    const result = toCompetitorSocialProfileCreateInput(input);
    assert.equal(result[0].label, "Company page");
  });
});
