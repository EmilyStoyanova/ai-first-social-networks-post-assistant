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

  it("names every label of the topic priorities section in both locales", () => {
    // Rendered from a list, with the group's key as the stem — a missing
    // `${key}Hint` or `${key}Placeholder` throws in place of the field.
    const keys = [
      "title",
      "help",
      "add",
      "remove",
      "empty",
      ...["top", "medium", "avoided"].flatMap((group) => [
        group,
        `${group}Hint`,
        `${group}Placeholder`,
      ]),
      ...["empty", "tooLong", "limitReached", "duplicate", "conflict"].map((e) => `errors.${e}`),
    ];

    for (const key of keys) {
      for (const [locale, messages] of [
        ["en", en],
        ["bg", bg],
      ] as const) {
        const value = lookup(messages, `brandGuidelines.topicPriorities.${key}`);
        assert.equal(
          typeof value,
          "string",
          `brandGuidelines.topicPriorities.${key} missing from ${locale}`
        );
      }
    }
  });

  it("names the calendar's publishing windows section and its weekdays", () => {
    // The section heading plus the seven day names it renders each window with.
    // Both are asked for by name at render time — `channels.days.${day}` from a
    // stored token — and a missing one throws in place of the section.
    for (const [locale, messages] of [
      ["en", en],
      ["bg", bg],
    ] as const) {
      const title = lookup(messages, "planner.calendar.publishingWindows");
      assert.equal(
        typeof title,
        "string",
        `planner.calendar.publishingWindows missing from ${locale}`
      );
      assert.ok(
        (title as string).trim().length > 0,
        `planner.calendar.publishingWindows is blank in ${locale}`
      );

      for (const day of [
        "MONDAY",
        "TUESDAY",
        "WEDNESDAY",
        "THURSDAY",
        "FRIDAY",
        "SATURDAY",
        "SUNDAY",
      ]) {
        assert.equal(
          typeof lookup(messages, `channels.days.${day}`),
          "string",
          `channels.days.${day} missing from ${locale}`
        );
      }
    }
  });

  it("names every part of the channel analytics dashboard in both locales", () => {
    // Every one of these is asked for by name at render time, several from a
    // list (`period.${option}`, `sources.avg`), and next-intl throws in place of
    // the element rather than falling back. The period keys start with a digit,
    // which is exactly the sort of key a hand edit gets wrong.
    const keys = [
      "period.label",
      ...["7d", "30d", "3m", "1y"].map((p) => `period.${p}`),
      "timeZoneNote",
      ...[
        "publishedPosts",
        "avgEngagementRate",
        "notReported",
        "fromPosts",
        "awaitingMetrics",
        "allChannelsNote",
      ].map((k) => `kpi.${k}`),
      ...[
        "title",
        "description",
        "metricLabel",
        "imageLabel",
        "note",
        "emptyTitle",
        "emptyDescription",
      ].map((k) => `chart.${k}`),
      ...["title", "description", "rankedBy", "emptyTitle", "emptyDescription"].map(
        (k) => `topPosts.${k}`
      ),
      ...[
        "title",
        "description",
        "source",
        "posts",
        "avg",
        "reportedBy",
        "companyContent",
        "averageNote",
      ].map((k) => `sources.${k}`),
      ...["title", "ownerDescription", "ownerAction", "editorDescription"].map(
        (k) => `notConfigured.${k}`
      ),
      ...["title", "description"].map((k) => `noPosts.${k}`),
    ];

    for (const key of keys) {
      for (const [locale, messages] of [
        ["en", en],
        ["bg", bg],
      ] as const) {
        const value = lookup(messages, `planner.analytics.${key}`);
        assert.equal(typeof value, "string", `planner.analytics.${key} missing from ${locale}`);
        assert.ok(
          (value as string).trim().length > 0,
          `planner.analytics.${key} is blank in ${locale}`
        );
      }
    }
  });

  it("labels every metric the analytics dashboard can display", () => {
    // The KPI cards, the chart switcher and the top-post rows all label a metric
    // by its own key, so a metric the normalizer can store must have a name in
    // both locales — `follows` was the one that did not.
    const metrics = [
      "reactions",
      "comments",
      "shares",
      "impressions",
      "clicks",
      "reach",
      "views",
      "saves",
      "follows",
      "engagementRate",
    ];

    for (const metric of metrics) {
      for (const [locale, messages] of [
        ["en", en],
        ["bg", bg],
      ] as const) {
        assert.equal(
          typeof lookup(messages, `analytics.${metric}`),
          "string",
          `analytics.${metric} missing from ${locale}`
        );
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
