import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyPostEdit, type EditablePost } from "./apply-post-edit";

/** A post as a grid holds it — only the fields an edit can touch. */
function post(overrides: Partial<EditablePost> = {}): EditablePost {
  return { id: "p-1", text: "Original text", hashtags: ["ai", "marketing"], ...overrides };
}

describe("applyPostEdit", () => {
  it("replaces the edited post's content in the list", () => {
    const list = [post(), post({ id: "p-2", text: "Sibling" })];

    const next = applyPostEdit(list, "p-1", "Edited text", ["ai", "marketing"]);

    assert.equal(next[0].text, "Edited text");
    // The parent/list record is what a remounting card re-seeds from, so this
    // IS the assertion that the edit survives without a browser reload.
    assert.notEqual(next, list);
  });

  it("replaces the edited post's hashtags", () => {
    const list = [post()];

    const next = applyPostEdit(list, "p-1", "Original text", ["rebrand"]);

    assert.deepEqual(next[0].hashtags, ["rebrand"]);
    assert.equal(next[0].text, "Original text");
  });

  it("clears hashtags when the edit removed every one", () => {
    // The service filters blanks out, so an emptied field arrives as []. A
    // falsy-guard here would have left the old chips on screen.
    const next = applyPostEdit([post()], "p-1", "Original text", []);

    assert.deepEqual(next[0].hashtags, []);
  });

  it("leaves every other post untouched, by identity", () => {
    const sibling = post({ id: "p-2", text: "Sibling" });
    const list = [post(), sibling];

    const next = applyPostEdit(list, "p-1", "Edited text", ["ai"]);

    // Same object, not merely an equal one — a new identity would remount the
    // sibling's card and throw away its in-flight state.
    assert.equal(next[1], sibling);
  });

  it("returns the same array when the id is not in the list", () => {
    const list = [post()];

    assert.equal(applyPostEdit(list, "p-999", "Edited text", ["ai"]), list);
  });

  it("returns the same array when the save changed nothing", () => {
    const list = [post()];

    // Re-submitting the existing text must not repaint the grid.
    assert.equal(applyPostEdit(list, "p-1", "Original text", ["ai", "marketing"]), list);
  });

  it("treats a hashtag reorder as a change", () => {
    const list = [post()];

    const next = applyPostEdit(list, "p-1", "Original text", ["marketing", "ai"]);

    // The chips are drawn in array order, so the screen would otherwise
    // disagree with what was written.
    assert.notEqual(next, list);
    assert.deepEqual(next[0].hashtags, ["marketing", "ai"]);
  });

  it("does not mutate the array it was given", () => {
    const list = [post()];

    applyPostEdit(list, "p-1", "Edited text", ["ai"]);

    assert.equal(list[0].text, "Original text");
    assert.deepEqual(list[0].hashtags, ["ai", "marketing"]);
  });
});
