import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { updatePost } from "./post-editor.service";
import type { PostEditorDb, PostEditorDeps } from "./post-editor.service";

interface PostRow {
  companyId: string;
  status: string;
  content: string;
  hashtags: string[];
}

/** An editable post as the card offers it — a draft the author still owns. */
function draft(overrides: Partial<PostRow> = {}): PostRow {
  return {
    companyId: "co-1",
    status: "draft",
    content: "Original text",
    hashtags: ["ai", "marketing"],
    ...overrides,
  };
}

interface Captured {
  postUpdates: { content?: string; hashtags?: string[] }[];
  versionsCreated: { version: number; content: string; changedBy: string }[];
  auditMetadata: { changedFields?: string[] }[];
}

function makeDeps(
  post: PostRow | null,
  { role = "editor", lastVersion = 0 }: { role?: string | null; lastVersion?: number } = {}
): { deps: PostEditorDeps; captured: Captured } {
  const captured: Captured = { postUpdates: [], versionsCreated: [], auditMetadata: [] };

  const db: PostEditorDb = {
    post: {
      findUnique: async () => post,
      update: async ({ data }) => {
        captured.postUpdates.push(data);
        return {};
      },
    },
    postVersion: {
      findFirst: async () => (lastVersion === 0 ? null : { version: lastVersion }),
      create: async ({ data }) => {
        captured.versionsCreated.push({
          version: data.version,
          content: data.content,
          changedBy: data.changedBy,
        });
        return {};
      },
    },
    companyMember: {
      findFirst: async () => (role === null ? null : { role }),
    },
  };

  const auditLog: PostEditorDeps["auditLog"] = async (entry) => {
    captured.auditMetadata.push((entry.metadata ?? {}) as { changedFields?: string[] });
  };

  return { deps: { db, auditLog }, captured };
}

describe("updatePost", () => {
  it("persists edited content", async () => {
    const { deps, captured } = makeDeps(draft());

    const result = await updatePost(
      "p-1",
      "u-1",
      false,
      { content: "Edited text", hashtags: ["ai", "marketing"] },
      deps
    );

    assert.equal(result.success, true);
    assert.equal(captured.postUpdates.length, 1);
    assert.equal(captured.postUpdates[0].content, "Edited text");
  });

  it("persists edited hashtags", async () => {
    const { deps, captured } = makeDeps(draft());

    const result = await updatePost(
      "p-1",
      "u-1",
      false,
      { content: "Original text", hashtags: ["rebrand", "launch"] },
      deps
    );

    assert.equal(result.success, true);
    assert.deepEqual(captured.postUpdates[0].hashtags, ["rebrand", "launch"]);
  });

  it("reports the values it wrote, not the ones it was handed", async () => {
    // The bug this closes: the card used to repaint from its own request, so a
    // trailing newline or a stray "  " between tags left the screen showing
    // something the database did not hold.
    const { deps, captured } = makeDeps(draft());

    const result = await updatePost(
      "p-1",
      "u-1",
      false,
      { content: "  Edited text\n\n", hashtags: ["ai", "   ", "launch"] },
      deps
    );

    assert.equal(result.success, true);
    assert.ok(result.success);
    assert.equal(result.content, "Edited text");
    assert.deepEqual(result.hashtags, ["ai", "launch"]);
    // And what it reports is exactly what went to the database.
    assert.equal(result.content, captured.postUpdates[0].content);
    assert.deepEqual(result.hashtags, captured.postUpdates[0].hashtags);
  });

  it("keeps the pre-edit content as a new version", async () => {
    const { deps, captured } = makeDeps(draft(), { lastVersion: 2 });

    await updatePost("p-1", "u-1", false, { content: "Edited text", hashtags: [] }, deps);

    assert.deepEqual(captured.versionsCreated, [
      { version: 3, content: "Original text", changedBy: "u-1" },
    ]);
  });

  it("records which fields changed", async () => {
    const { deps, captured } = makeDeps(draft());

    await updatePost(
      "p-1",
      "u-1",
      false,
      { content: "Edited text", hashtags: ["ai", "marketing"] },
      deps
    );

    assert.deepEqual(captured.auditMetadata[0].changedFields, ["content"]);
  });

  it("writes nothing when the content is blank", async () => {
    const { deps, captured } = makeDeps(draft());

    const result = await updatePost("p-1", "u-1", false, { content: "   ", hashtags: [] }, deps);

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "VALIDATION_ERROR");
    // A failed save must leave the stored post exactly as it was — the card
    // keeps showing it because the modal never reaches `onSaved`.
    assert.deepEqual(captured.postUpdates, []);
    assert.deepEqual(captured.versionsCreated, []);
  });

  it("refuses to edit a post that has already gone out", async () => {
    const { deps, captured } = makeDeps(draft({ status: "sent_to_buffer" }));

    const result = await updatePost(
      "p-1",
      "u-1",
      false,
      { content: "Edited text", hashtags: [] },
      deps
    );

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "POST_LOCKED");
    assert.deepEqual(captured.postUpdates, []);
  });

  it("refuses a post the user has no membership for", async () => {
    const { deps, captured } = makeDeps(draft(), { role: null });

    const result = await updatePost(
      "p-1",
      "u-1",
      false,
      { content: "Edited text", hashtags: [] },
      deps
    );

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "NOT_FOUND");
    assert.deepEqual(captured.postUpdates, []);
  });

  it("returns NOT_FOUND for a post that does not exist", async () => {
    const { deps, captured } = makeDeps(null);

    const result = await updatePost(
      "p-1",
      "u-1",
      false,
      { content: "Edited text", hashtags: [] },
      deps
    );

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "NOT_FOUND");
    assert.deepEqual(captured.postUpdates, []);
  });
});
