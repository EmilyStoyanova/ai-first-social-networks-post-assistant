import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatPostingWindow, postingWindowLines } from "./posting-window-label";

/** The Bulgarian day names the channel card looks up, as `channels.days.*`. */
const BG_DAYS: Record<string, string> = {
  MONDAY: "Понеделник",
  TUESDAY: "Вторник",
  WEDNESDAY: "Сряда",
  THURSDAY: "Четвъртък",
  FRIDAY: "Петък",
  SATURDAY: "Събота",
  SUNDAY: "Неделя",
};

const bg = (day: string) => BG_DAYS[day] ?? day;
const en = (day: string) => day.charAt(0) + day.slice(1).toLowerCase();

describe("formatPostingWindow", () => {
  it("localises the day and leaves the times alone", () => {
    assert.equal(
      formatPostingWindow({ day: "MONDAY", start: "09:00", end: "17:00" }, bg),
      "Понеделник 09:00–17:00"
    );
    assert.equal(
      formatPostingWindow({ day: "MONDAY", start: "09:00", end: "17:00" }, en),
      "Monday 09:00–17:00"
    );
  });

  it("falls through to the stored token for a day the locale has no name for", () => {
    // next-intl throws on a missing key, so the card checks before asking. A
    // recognisable MONDAY beats a thrown message in place of the whole row.
    assert.equal(
      formatPostingWindow({ day: "MONDAY", start: "08:00", end: "09:00" }, (d) => d),
      "MONDAY 08:00–09:00"
    );
  });
});

describe("postingWindowLines", () => {
  it("renders every configured window, one line each", () => {
    // The case the summary exists for: an owner saved several windows and has to
    // be able to read all of them back without entering edit mode.
    assert.deepEqual(
      postingWindowLines(
        [
          { day: "MONDAY", start: "09:00", end: "17:00" },
          { day: "TUESDAY", start: "09:00", end: "17:00" },
          { day: "FRIDAY", start: "18:30", end: "20:00" },
        ],
        bg
      ),
      ["Понеделник 09:00–17:00", "Вторник 09:00–17:00", "Петък 18:30–20:00"]
    );
  });

  it("keeps the order the windows were saved in", () => {
    assert.deepEqual(
      postingWindowLines(
        [
          { day: "FRIDAY", start: "18:00", end: "19:00" },
          { day: "MONDAY", start: "09:00", end: "10:00" },
        ],
        en
      ),
      ["Friday 18:00–19:00", "Monday 09:00–10:00"]
    );
  });

  it("renders nothing at all when no schedule is saved", () => {
    // The card shows no row in this case rather than a "not set" placeholder.
    assert.deepEqual(postingWindowLines([], bg), []);
  });
});
