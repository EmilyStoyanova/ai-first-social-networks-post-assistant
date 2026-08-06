import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveGenerationChannels } from "./generation-channels";
import type { ChannelConfigItem } from "@/lib/services/company/list-channel-configs.service";

function makeConfig(overrides: Partial<ChannelConfigItem> = {}): ChannelConfigItem {
  return {
    id: "cfg-1",
    channel: "facebook",
    bufferProfileId: "profile-1",
    bufferProfileName: "Acme Page",
    enabled: true,
    imageRequired: false,
    includeSourceLink: false,
    autoGenerateImage: false,
    postingLanguage: null,
    postsPerDay: 1,
    postsPerWeek: 5,
    postingWindows: [],
    automationModeOverride: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("resolveGenerationChannels", () => {
  it("offers an enabled channel backed by a Buffer profile", () => {
    const result = resolveGenerationChannels([makeConfig()]);

    assert.deepEqual(result, [
      { channel: "FACEBOOK", postingLanguage: null, imageRequired: false },
    ]);
  });

  it("uppercases the channel so it matches the form's CHANNELS constant", () => {
    const result = resolveGenerationChannels([makeConfig({ channel: "linkedin" })]);

    assert.equal(result[0]?.channel, "LINKEDIN");
  });

  it("excludes a channel the owner has not enabled", () => {
    const result = resolveGenerationChannels([makeConfig({ enabled: false })]);

    assert.deepEqual(result, []);
  });

  it("excludes a legacy config with no Buffer profile behind it", () => {
    const result = resolveGenerationChannels([makeConfig({ bufferProfileId: null })]);

    assert.deepEqual(result, []);
  });

  it("collapses several Buffer profiles on the same social channel to one option", () => {
    const result = resolveGenerationChannels([
      makeConfig({ id: "cfg-1", bufferProfileId: "p-1", bufferProfileName: "Page A" }),
      makeConfig({ id: "cfg-2", bufferProfileId: "p-2", bufferProfileName: "Page B" }),
    ]);

    assert.equal(result.length, 1);
    assert.equal(result[0]?.channel, "FACEBOOK");
  });

  it("keeps the first row's settings when profiles collide on one channel", () => {
    const result = resolveGenerationChannels([
      makeConfig({ bufferProfileId: "p-1", postingLanguage: "bg", imageRequired: true }),
      makeConfig({ bufferProfileId: "p-2", postingLanguage: "en", imageRequired: false }),
    ]);

    assert.equal(result[0]?.postingLanguage, "bg");
    assert.equal(result[0]?.imageRequired, true);
  });

  it("carries the per-channel posting language through for the language label", () => {
    const result = resolveGenerationChannels([makeConfig({ postingLanguage: "bg" })]);

    assert.equal(result[0]?.postingLanguage, "bg");
  });

  it("carries imageRequired through so the form can warn about a skipped image", () => {
    const result = resolveGenerationChannels([makeConfig({ imageRequired: true })]);

    assert.equal(result[0]?.imageRequired, true);
  });

  it("preserves input order across distinct channels", () => {
    const result = resolveGenerationChannels([
      makeConfig({ channel: "linkedin", bufferProfileId: "p-1" }),
      makeConfig({ channel: "facebook", bufferProfileId: "p-2" }),
      makeConfig({ channel: "tiktok", bufferProfileId: "p-3" }),
    ]);

    assert.deepEqual(
      result.map((c) => c.channel),
      ["LINKEDIN", "FACEBOOK", "TIKTOK"]
    );
  });

  it("returns an empty list when the company has connected nothing", () => {
    assert.deepEqual(resolveGenerationChannels([]), []);
  });

  it("keeps only the connected, enabled channels out of a mixed set", () => {
    const result = resolveGenerationChannels([
      makeConfig({ channel: "facebook", bufferProfileId: "p-1", enabled: true }),
      makeConfig({ channel: "linkedin", bufferProfileId: "p-2", enabled: false }),
      makeConfig({ channel: "instagram", bufferProfileId: null, enabled: true }),
      makeConfig({ channel: "tiktok", bufferProfileId: "p-4", enabled: true }),
    ]);

    assert.deepEqual(
      result.map((c) => c.channel),
      ["FACEBOOK", "TIKTOK"]
    );
  });
});
