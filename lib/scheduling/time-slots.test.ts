import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LAST_SLOT_MINUTES,
  SLOT_MINUTES,
  TIME_SLOTS,
  isSlotAligned,
  minutesToTime,
  slotOptions,
  snapMinutesToSlot,
  snapToSlot,
  timeToMinutes,
} from "./time-slots";
import { PUBLISH_SWEEP_INTERVAL_MS } from "./publish-window";
import { parseTimeOfDay, formatTimeOfDay } from "./bulk-schedule";

describe("the slot list follows the publishing sweep", () => {
  it("is spaced exactly one sweep apart", () => {
    // The whole justification for the list: these are the times a sweep can hit.
    // A hard-coded 30 here would let the two drift apart silently.
    assert.equal(SLOT_MINUTES, PUBLISH_SWEEP_INTERVAL_MS / 60_000);
    assert.equal(SLOT_MINUTES, 30);
  });

  it("covers the whole day, first slot to last", () => {
    assert.equal(TIME_SLOTS.length, 48);
    assert.equal(TIME_SLOTS[0], "00:00");
    assert.equal(TIME_SLOTS[1], "00:30");
    assert.equal(TIME_SLOTS.at(-1), "23:30");
  });

  it("offers nothing but whole and half hours, in order", () => {
    for (const [i, slot] of TIME_SLOTS.entries()) {
      assert.equal(timeToMinutes(slot), i * SLOT_MINUTES, slot);
      assert.match(slot, /^\d{2}:(00|30)$/);
    }
  });

  it("stops at 23:30 rather than wrapping to midnight", () => {
    assert.equal(minutesToTime(LAST_SLOT_MINUTES), "23:30");
    assert.equal(TIME_SLOTS.includes("24:00"), false);
  });

  it("is a list every other reader agrees is real times of day", () => {
    for (const slot of TIME_SLOTS) {
      // parseTimeOfDay is what the API validates a submitted time with.
      const time = parseTimeOfDay(slot);
      assert.notEqual(time, null, slot);
      assert.equal(formatTimeOfDay(time!), slot);
    }
  });
});

describe("timeToMinutes / minutesToTime", () => {
  it("reads a wall clock", () => {
    assert.equal(timeToMinutes("00:00"), 0);
    assert.equal(timeToMinutes("09:15"), 555);
    assert.equal(timeToMinutes("23:59"), 1439);
  });

  it("refuses anything a clock cannot show", () => {
    for (const bad of ["24:00", "25:00", "12:60", "9:00", "09:0", "0900", "", "09:00:00", "abc"]) {
      assert.equal(timeToMinutes(bad), null, bad);
    }
  });

  it("round-trips", () => {
    for (const value of ["00:00", "07:45", "16:15", "18:30", "23:59"]) {
      assert.equal(minutesToTime(timeToMinutes(value)!), value);
    }
  });
});

describe("isSlotAligned", () => {
  it("accepts a whole or half hour", () => {
    for (const value of ["00:00", "00:30", "09:00", "18:30", "23:30"]) {
      assert.equal(isSlotAligned(value), true, value);
    }
  });

  it("rejects a time between two slots", () => {
    for (const value of ["16:15", "09:01", "23:59", "12:29"]) {
      assert.equal(isSlotAligned(value), false, value);
    }
  });

  it("rejects what is not a time at all", () => {
    for (const value of ["", "25:00", "abc"]) {
      assert.equal(isSlotAligned(value), false, value);
    }
  });
});

describe("snapToSlot — forwards, because that is the sweep that publishes it", () => {
  it("moves 16:15 to 16:30, the sweep that would have sent it", () => {
    // The reason this module exists: a post written for 16:15 goes out at 16:30,
    // so 16:30 is what the time already meant.
    assert.equal(snapToSlot("16:15"), "16:30");
  });

  it("leaves a time that is already a slot alone", () => {
    for (const value of ["00:00", "09:00", "18:30", "23:30"]) {
      assert.equal(snapToSlot(value), value, value);
    }
  });

  it("never moves a time earlier, whatever the minute", () => {
    for (let minutes = 0; minutes <= LAST_SLOT_MINUTES; minutes++) {
      const snapped = snapMinutesToSlot(minutes);
      assert.ok(snapped >= minutes, `${minutes} → ${snapped}`);
      assert.ok(snapped - minutes < SLOT_MINUTES, `${minutes} moved too far`);
      assert.equal(snapped % SLOT_MINUTES, 0);
    }
  });

  it("clamps the end of the day instead of spilling into the next one", () => {
    // 23:45 has no later slot of its own. Moving it to 00:00 would put the post
    // on a day nobody chose — a worse answer than a time the caller can refuse.
    assert.equal(snapToSlot("23:45"), "23:30");
    assert.equal(snapToSlot("23:59"), "23:30");
    assert.equal(snapMinutesToSlot(24 * 60), LAST_SLOT_MINUTES);
  });

  it("is null for anything that is not a time of day", () => {
    for (const value of ["", "25:00", "abc"]) {
      assert.equal(snapToSlot(value), null, value);
    }
  });

  it("is idempotent, so re-opening an editor cannot walk a time forward", () => {
    for (const value of ["16:15", "09:00", "23:45", "00:01"]) {
      const once = snapToSlot(value)!;
      assert.equal(snapToSlot(once), once, value);
    }
  });

  it("survives an unusable number rather than producing a broken clock", () => {
    for (const minutes of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const snapped = snapMinutesToSlot(minutes);
      assert.ok(snapped >= 0 && snapped <= LAST_SLOT_MINUTES, String(minutes));
      assert.equal(snapped % SLOT_MINUTES, 0);
    }
  });
});

describe("slotOptions — an existing off-slot time is still shown", () => {
  it("is just the slots for a time that is one", () => {
    assert.equal(slotOptions("09:00"), TIME_SLOTS);
    assert.equal(slotOptions("23:30"), TIME_SLOTS);
  });

  it("adds a post's own 16:15 rather than losing it", () => {
    // Posts scheduled before this rule existed keep their times (nothing
    // migrates them), and a select whose value is missing renders empty — which
    // would read as the time having been dropped.
    const options = slotOptions("16:15");
    assert.equal(options.includes("16:15"), true);
    assert.equal(options.length, TIME_SLOTS.length + 1);
  });

  it("puts it in its place on the clock", () => {
    const options = slotOptions("16:15");
    assert.deepEqual(options.slice(31, 35), ["15:30", "16:00", "16:15", "16:30"]);
    assert.deepEqual([...options].sort(), options);
  });

  it("adds nothing for an empty or unusable value", () => {
    for (const value of ["", "25:00", "abc"]) {
      assert.equal(slotOptions(value), TIME_SLOTS, value);
    }
  });
});
