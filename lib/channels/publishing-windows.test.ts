import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { publishingWindowGroups } from "./publishing-windows";
import { postingWindowLines } from "./posting-window-label";
import { ALL_CHANNELS } from "./channel-scope";
import type { ChannelConfigItem } from "@/lib/services/company/list-channel-configs.service";

/** A config as `listChannelConfigs` returns it — only the fields the rule reads matter. */
function config(overrides: Partial<ChannelConfigItem> & { channel: string }): ChannelConfigItem {
  return {
    id: `cfg-${overrides.channel}`,
    bufferProfileId: `buf-${overrides.channel}`,
    bufferProfileName: null,
    enabled: true,
    imageRequired: false,
    includeSourceLink: false,
    autoGenerateImage: false,
    postingLanguage: null,
    postsPerDay: 1,
    postsPerWeek: 3,
    postingWindows: [],
    automationModeOverride: null,
    updatedAt: null,
    ...overrides,
  };
}

const FACEBOOK = config({
  channel: "facebook",
  postingWindows: [
    { day: "MONDAY", start: "09:00", end: "17:00" },
    { day: "FRIDAY", start: "18:30", end: "20:00" },
  ],
});

const INSTAGRAM = config({
  channel: "instagram",
  postingWindows: [{ day: "WEDNESDAY", start: "11:00", end: "13:00" }],
});

/** Enabled and connected, but the owner never authored a schedule for it. */
const LINKEDIN_NO_WINDOWS = config({ channel: "linkedin" });

describe("publishingWindowGroups", () => {
  it("shows every configured channel under All Channels", () => {
    const groups = publishingWindowGroups([FACEBOOK, INSTAGRAM], ALL_CHANNELS);

    assert.deepEqual(
      groups.map((g) => g.label),
      ["Facebook", "Instagram"]
    );
    assert.deepEqual(groups[0].windows, FACEBOOK.postingWindows);
    assert.deepEqual(groups[1].windows, INSTAGRAM.postingWindows);
  });

  it("shows only the selected channel's windows", () => {
    const groups = publishingWindowGroups([FACEBOOK, INSTAGRAM], "INSTAGRAM");

    assert.deepEqual(
      groups.map((g) => g.channel),
      ["INSTAGRAM"]
    );
    assert.deepEqual(groups[0].windows, [{ day: "WEDNESDAY", start: "11:00", end: "13:00" }]);
  });

  it("leaves out a channel that has no windows configured", () => {
    // Enabled and connected is not enough: nothing was authored, so there is no
    // schedule to read back — and inventing one (a default 10:00, say) is what
    // the whole posting-window path refuses to do.
    const groups = publishingWindowGroups([FACEBOOK, LINKEDIN_NO_WINDOWS], ALL_CHANNELS);

    assert.deepEqual(
      groups.map((g) => g.channel),
      ["FACEBOOK"]
    );
  });

  it("returns nothing when no channel in scope has windows", () => {
    // The panel renders no section at all for this — an empty box under the
    // toolbar would be a heading with no answer beneath it.
    assert.deepEqual(publishingWindowGroups([LINKEDIN_NO_WINDOWS], ALL_CHANNELS), []);
    assert.deepEqual(publishingWindowGroups([FACEBOOK], "LINKEDIN"), []);
    assert.deepEqual(publishingWindowGroups([], ALL_CHANNELS), []);
  });

  it("leaves out a channel that is switched off or not backed by a profile", () => {
    // Same rule the channel switcher is built from: a scope that is not on offer
    // must not have its schedule shown beside the ones that are.
    const disabled = config({ ...INSTAGRAM, enabled: false });
    const legacy = config({ ...INSTAGRAM, bufferProfileId: null });

    assert.deepEqual(publishingWindowGroups([disabled], ALL_CHANNELS), []);
    assert.deepEqual(publishingWindowGroups([legacy], ALL_CHANNELS), []);
  });

  it("orders channels canonically, not by how the configs arrived", () => {
    const groups = publishingWindowGroups([INSTAGRAM, FACEBOOK], ALL_CHANNELS);

    assert.deepEqual(
      groups.map((g) => g.channel),
      ["FACEBOOK", "INSTAGRAM"]
    );
  });

  it("collapses several profiles on one network to a single group, keeping every window", () => {
    // Two Facebook pages are two configs but one channel — the calendar is
    // addressed by channel. Collapsing them must not lose a schedule: the
    // weekly cron reads channel configs ROW BY ROW, so the second page's
    // windows are live whatever the first page's say.
    const second = config({
      ...FACEBOOK,
      id: "cfg-facebook-2",
      bufferProfileId: "buf-facebook-2",
      postingWindows: [{ day: "SUNDAY", start: "08:00", end: "09:00" }],
    });

    const groups = publishingWindowGroups([FACEBOOK, second], ALL_CHANNELS);

    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].windows, [
      ...FACEBOOK.postingWindows,
      { day: "SUNDAY", start: "08:00", end: "09:00" },
    ]);
  });

  it("shows a network whose FIRST profile has no windows but a later one does", () => {
    // The regression this guards: picking one config per channel and reading
    // its windows drops the network entirely when the row that won the collapse
    // happens to be the unconfigured one — while the cron goes on publishing to
    // the page that IS configured. Config order is by profile name, so which
    // row comes first is incidental and must not decide what is displayed.
    const unscheduled = config({
      channel: "facebook",
      id: "cfg-facebook-a",
      bufferProfileId: "buf-facebook-a",
      bufferProfileName: "A Page",
      postingWindows: [],
    });
    const scheduled = config({
      channel: "facebook",
      id: "cfg-facebook-b",
      bufferProfileId: "buf-facebook-b",
      bufferProfileName: "B Page",
      postingWindows: [{ day: "THURSDAY", start: "07:00", end: "08:00" }],
    });

    const groups = publishingWindowGroups([unscheduled, scheduled], ALL_CHANNELS);

    assert.deepEqual(
      groups.map((g) => g.channel),
      ["FACEBOOK"]
    );
    assert.deepEqual(groups[0].windows, [{ day: "THURSDAY", start: "07:00", end: "08:00" }]);
  });

  it("shows a window once when two profiles on a network share it", () => {
    // Both pages posting Monday 09:00–17:00 is one line of schedule to read,
    // not two identical chips side by side.
    const twin = config({
      ...FACEBOOK,
      id: "cfg-facebook-2",
      bufferProfileId: "buf-facebook-2",
      postingWindows: [
        { day: "MONDAY", start: "09:00", end: "17:00" },
        { day: "SUNDAY", start: "08:00", end: "09:00" },
      ],
    });

    const groups = publishingWindowGroups([FACEBOOK, twin], ALL_CHANNELS);

    assert.deepEqual(groups[0].windows, [
      { day: "MONDAY", start: "09:00", end: "17:00" },
      { day: "FRIDAY", start: "18:30", end: "20:00" },
      { day: "SUNDAY", start: "08:00", end: "09:00" },
    ]);
  });

  it("ignores the windows of a profile that is switched off", () => {
    // A network stays on offer because one page is enabled; the disabled page's
    // schedule is not part of what that network publishes.
    const disabledSecond = config({
      ...FACEBOOK,
      id: "cfg-facebook-2",
      bufferProfileId: "buf-facebook-2",
      enabled: false,
      postingWindows: [{ day: "SUNDAY", start: "08:00", end: "09:00" }],
    });

    const groups = publishingWindowGroups([FACEBOOK, disabledSecond], ALL_CHANNELS);

    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].windows, FACEBOOK.postingWindows);
  });
});

describe("publishing windows as rendered", () => {
  /** The `channels.days.*` names, as the panel looks them up. */
  const BG_DAYS: Record<string, string> = {
    MONDAY: "Понеделник",
    TUESDAY: "Вторник",
    WEDNESDAY: "Сряда",
    THURSDAY: "Четвъртък",
    FRIDAY: "Петък",
    SATURDAY: "Събота",
    SUNDAY: "Неделя",
  };
  const EN_DAYS: Record<string, string> = {
    MONDAY: "Monday",
    WEDNESDAY: "Wednesday",
    FRIDAY: "Friday",
  };

  const SEPARATOR = " · ";

  it("localises the weekday and shows the stored times unchanged", () => {
    const [facebook] = publishingWindowGroups([FACEBOOK], ALL_CHANNELS);

    assert.deepEqual(
      postingWindowLines(facebook.windows, (day) => BG_DAYS[day] ?? day, SEPARATOR),
      ["Понеделник · 09:00–17:00", "Петък · 18:30–20:00"]
    );
    assert.deepEqual(
      postingWindowLines(facebook.windows, (day) => EN_DAYS[day] ?? day, SEPARATOR),
      ["Monday · 09:00–17:00", "Friday · 18:30–20:00"]
    );
  });

  it("renders each channel's own windows under All Channels", () => {
    const rendered = publishingWindowGroups([FACEBOOK, INSTAGRAM], ALL_CHANNELS).map((group) => [
      group.label,
      postingWindowLines(group.windows, (day) => BG_DAYS[day] ?? day, SEPARATOR),
    ]);

    assert.deepEqual(rendered, [
      ["Facebook", ["Понеделник · 09:00–17:00", "Петък · 18:30–20:00"]],
      ["Instagram", ["Сряда · 11:00–13:00"]],
    ]);
  });
});
