import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { archivedWhereFragment, matchesArchivedWhere } from "./competitor-list-filter";

const ACTIVE = { archivedAt: null };
const ARCHIVED = { archivedAt: new Date("2026-01-01") };
const ROWS = [ACTIVE, ARCHIVED];

describe("archivedWhereFragment / matchesArchivedWhere", () => {
  it('"active" matches only unarchived rows — archived competitors are excluded from the default listing (§3.13)', () => {
    const fragment = archivedWhereFragment("active");
    const matched = ROWS.filter((r) => matchesArchivedWhere(fragment, r));
    assert.deepEqual(matched, [ACTIVE]);
  });

  it('"archived" matches only archived rows — this is the restore view', () => {
    const fragment = archivedWhereFragment("archived");
    const matched = ROWS.filter((r) => matchesArchivedWhere(fragment, r));
    assert.deepEqual(matched, [ARCHIVED]);
  });

  it('"all" matches every row, active and archived alike', () => {
    const fragment = archivedWhereFragment("all");
    const matched = ROWS.filter((r) => matchesArchivedWhere(fragment, r));
    assert.deepEqual(matched, ROWS);
  });
});
