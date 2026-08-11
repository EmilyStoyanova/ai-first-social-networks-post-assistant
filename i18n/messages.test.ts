import { describe, it } from "node:test";
import assert from "node:assert/strict";
import en from "./messages/en.json";
import bg from "./messages/bg.json";

/** Every leaf key, dotted — `contentSources.organizer` and so on. */
function leafKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    leafKeys(v, prefix ? `${prefix}.${k}` : k)
  );
}

function lookup(messages: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      messages
    );
}

describe("i18n messages", () => {
  it("has the same keys in both locales", () => {
    // next-intl throws on a missing key rather than falling back, so a key added
    // to one locale only is a runtime crash on the other, not a cosmetic gap.
    const enKeys = new Set(leafKeys(en));
    const bgKeys = new Set(leafKeys(bg));

    assert.deepEqual(
      [...enKeys].filter((k) => !bgKeys.has(k)),
      [],
      "keys present in en but missing from bg"
    );
    assert.deepEqual(
      [...bgKeys].filter((k) => !enKeys.has(k)),
      [],
      "keys present in bg but missing from en"
    );
  });

  it("resolves every content source form label in both locales", () => {
    // The labels the form asks for by name. A typo here renders as a thrown
    // MISSING_MESSAGE in place of the field.
    const formKeys = [
      "sourceType",
      "name",
      "namePlaceholder",
      "organizer",
      "organizerPlaceholder",
      "organizerHelp",
      "feedUrl",
      "pageUrl",
      "promptText",
      "eventTitle",
      "eventTitlePlaceholder",
      "eventDate",
      "description",
      "eventUrl",
      "eventUrlHelp",
    ];

    for (const key of formKeys) {
      for (const [locale, messages] of [
        ["en", en],
        ["bg", bg],
      ] as const) {
        const value = lookup(messages, `contentSources.${key}`);
        assert.equal(typeof value, "string", `contentSources.${key} missing from ${locale}`);
        assert.ok(
          (value as string).trim().length > 0,
          `contentSources.${key} is blank in ${locale}`
        );
      }
    }
  });

  it("names every field of the reschedule editor in both locales", () => {
    // The editor is a date input plus a slot picker, each with an accessible name
    // of its own, and a line explaining why only half hours are offered. A typo
    // in one of these keys throws where the control should be.
    for (const key of ["newTime", "newDate", "newTimeOfDay", "slotHint", "timeZoneHint"]) {
      for (const [locale, messages] of [
        ["en", en],
        ["bg", bg],
      ] as const) {
        const value = lookup(messages, `posts.schedule.${key}`);
        assert.equal(typeof value, "string", `posts.schedule.${key} missing from ${locale}`);
      }
    }
  });

  it("labels the calendar event's name field as the organizer", () => {
    // The shared `name` column holds the organiser for a calendar event, not the
    // event's own title — that is `contentSources.eventTitle`.
    assert.equal(lookup(en, "contentSources.organizer"), "Organizer");
    assert.equal(lookup(bg, "contentSources.organizer"), "Организатор");
    assert.notEqual(lookup(bg, "contentSources.organizer"), lookup(bg, "contentSources.name"));
  });
});
