import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APP_DATE_LOCALE,
  APP_TIME_ZONE,
  formatDate,
  formatDateLong,
  formatDateNumeric,
  formatDateTime,
} from "./format-date";

// An instant late enough in UTC that any positive offset rolls it to the NEXT
// day — the exact case that made the server ("16 Jul 2026, 21:30") and a
// Europe/Sofia browser ("17 Jul 2026, 00:30") disagree and throw React #418.
const LATE_EVENING_UTC = "2026-07-16T21:30:00.000Z";

const savedTz = process.env.TZ;
afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

// ─── Output shape ─────────────────────────────────────────────────────────────

describe("format-date — shapes", () => {
  it("renders date + time in the business zone", () => {
    assert.equal(formatDateTime(LATE_EVENING_UTC), "17 Jul 2026, 00:30");
  });

  it("renders date only", () => {
    assert.equal(formatDate(LATE_EVENING_UTC), "17 Jul 2026");
  });

  it("renders a long month", () => {
    assert.equal(formatDateLong(LATE_EVENING_UTC), "17 July 2026");
  });

  it("renders a zero-padded day", () => {
    assert.equal(formatDateNumeric("2026-07-05T10:00:00.000Z"), "05 Jul 2026");
  });

  it("accepts a Date as well as an ISO string", () => {
    assert.equal(formatDateTime(new Date(LATE_EVENING_UTC)), formatDateTime(LATE_EVENING_UTC));
  });

  it("returns an empty string for an unparseable input rather than 'Invalid Date'", () => {
    assert.equal(formatDate("not-a-date"), "");
  });

  it("honours an explicit locale while keeping the zone pinned", () => {
    // next-intl passes the request locale through for localised surfaces; the
    // zone must stay pinned regardless of which locale is used.
    assert.match(formatDateTime(LATE_EVENING_UTC, "bg-BG"), /2026/);
  });
});

// ─── Hydration safety — the actual regression guard ───────────────────────────
//
// React #418 was caused by the server and the browser resolving a DIFFERENT
// ambient time zone for the same instant. Node resolves the ambient zone from
// TZ, so flipping TZ reproduces "server render" vs "first client render".
//
// Two subtleties this suite has to respect, or it would pass while testing
// nothing:
//   1. Formatters are built LAZILY on first call, so each variant must be CALLED
//      while its zone is still active — not merely imported under it.
//   2. Formatters are memoised at module scope, so a single module instance
//      would cache the first zone it saw and then look invariant even if the
//      pinning were removed. A cache-busting query gives each zone a genuinely
//      fresh module instance, exactly like a fresh server/browser process.

async function formatInFreshModule(tz: string, cacheBuster: string): Promise<string> {
  process.env.TZ = tz;
  // The query must be key=value — a bare `?foo` resolves to a different module
  // shape under the tsx loader and silently yields no exports.
  const specifier = `./format-date.ts?case=${cacheBuster}`;
  const mod = (await import(specifier)) as typeof import("./format-date");
  return mod.formatDateTime(LATE_EVENING_UTC);
}

describe("format-date — identical on the server and the first client render", () => {
  it("renders the same text whether the module loads under UTC or Europe/Sofia", async () => {
    const asServer = await formatInFreshModule("UTC", "server");
    const asClient = await formatInFreshModule("Europe/Sofia", "client");

    assert.equal(
      asServer,
      asClient,
      `server render (${asServer}) must equal first client render (${asClient})`
    );
    assert.equal(asServer, "17 Jul 2026, 00:30");
  });

  it("stays identical for a viewer whose zone is nowhere near the business zone", async () => {
    const asServer = await formatInFreshModule("UTC", "server2");
    const inTokyo = await formatInFreshModule("Asia/Tokyo", "tokyo");
    const inNewYork = await formatInFreshModule("America/New_York", "ny");

    assert.deepEqual(new Set([asServer, inTokyo, inNewYork]).size, 1);
  });

  it("proves the unpinned formatting this module replaces really did drift", () => {
    // Guards the premise of the fix: if this ever stops drifting, the pinning is
    // no longer load-bearing and the assertions above would be testing nothing.
    const unpinned = (tz: string) => {
      process.env.TZ = tz;
      return new Date(LATE_EVENING_UTC).toLocaleString("en-GB", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    };

    assert.equal(unpinned("UTC"), "16 Jul 2026, 21:30");
    assert.equal(unpinned("Europe/Sofia"), "17 Jul 2026, 00:30");
  });
});

// ─── Configuration ────────────────────────────────────────────────────────────

describe("format-date — configuration", () => {
  it("pins a real IANA zone and a real locale", () => {
    assert.equal(APP_TIME_ZONE, "Europe/Sofia");
    assert.doesNotThrow(
      () => new Intl.DateTimeFormat(APP_DATE_LOCALE, { timeZone: APP_TIME_ZONE })
    );
  });
});
