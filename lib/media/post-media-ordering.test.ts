import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orderGalleryWithPostFirst } from "./post-media-ordering";

const item = (id: string) => ({ id });

describe("orderGalleryWithPostFirst", () => {
  it("puts the post's images before the rest of the gallery", async () => {
    const ordered = orderGalleryWithPostFirst(
      [item("post-a"), item("post-b")],
      [item("other-1"), item("post-a"), item("other-2")]
    );

    assert.deepEqual(
      ordered.map((i) => i.id),
      ["post-a", "post-b", "other-1", "other-2"]
    );
  });

  it("shows an image once when the gallery page already contains it", async () => {
    const ordered = orderGalleryWithPostFirst([item("post-a")], [item("post-a")]);

    assert.deepEqual(
      ordered.map((i) => i.id),
      ["post-a"]
    );
  });

  it("includes a post image the loaded gallery page does not have", async () => {
    // The gallery is paged and date-ordered, so an older asset this post is using
    // can be off the loaded page entirely. Prepending from the post's own list is
    // what keeps it reachable.
    const ordered = orderGalleryWithPostFirst([item("old-asset")], [item("new-1"), item("new-2")]);

    assert.equal(ordered[0].id, "old-asset");
    assert.equal(ordered.length, 3);
  });

  it("preserves the gallery order when the post has no images", async () => {
    const gallery = [item("a"), item("b")];

    const ordered = orderGalleryWithPostFirst([], gallery);

    assert.deepEqual(
      ordered.map((i) => i.id),
      ["a", "b"]
    );
    assert.notEqual(ordered, gallery, "returns a copy rather than the caller's array");
  });

  it("handles an empty gallery", async () => {
    const ordered = orderGalleryWithPostFirst([item("post-a")], []);

    assert.deepEqual(
      ordered.map((i) => i.id),
      ["post-a"]
    );
  });
});
