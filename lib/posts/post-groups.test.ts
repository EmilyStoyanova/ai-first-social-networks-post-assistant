import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  groupChannelVersions,
  groupPostsByTopic,
  removePostFromGroup,
  selectGroupPost,
  type GroupablePost,
} from "./post-groups";

function post(id: string, channel: string, contentGroupId: string | null = null): GroupablePost {
  return { id, channel, contentGroupId };
}

describe("groupPostsByTopic — grouped posts", () => {
  it("renders the channel versions of one topic as a single card", () => {
    const groups = groupPostsByTopic([
      post("p1", "FACEBOOK", "g1"),
      post("p2", "INSTAGRAM", "g1"),
      post("p3", "LINKEDIN", "g1"),
    ]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].contentGroupId, "g1");
    assert.equal(groups[0].posts.length, 3);
  });

  it("orders versions by channel, not by which was generated first", () => {
    // The anchor channel varies per topic — whichever succeeded first — so
    // creation order would make the dropdown read differently on every card.
    const groups = groupPostsByTopic([
      post("p1", "TIKTOK", "g1"),
      post("p2", "FACEBOOK", "g1"),
      post("p3", "INSTAGRAM", "g1"),
      post("p4", "LINKEDIN", "g1"),
    ]);

    assert.deepEqual(
      groups[0].posts.map((p) => p.channel),
      ["FACEBOOK", "LINKEDIN", "INSTAGRAM", "TIKTOK"]
    );
  });

  it("keeps separate topics apart", () => {
    const groups = groupPostsByTopic([
      post("p1", "FACEBOOK", "g1"),
      post("p2", "FACEBOOK", "g2"),
      post("p3", "INSTAGRAM", "g1"),
    ]);

    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups.map((g) => g.contentGroupId),
      ["g1", "g2"]
    );
    assert.equal(groups[0].posts.length, 2);
    assert.equal(groups[1].posts.length, 1);
  });

  it("places a group where its first post appeared", () => {
    // The caller sorts newest-first; a group must not jump the queue because a
    // later sibling exists.
    const groups = groupPostsByTopic([
      post("solo", "FACEBOOK", null),
      post("p1", "FACEBOOK", "g1"),
      post("p2", "INSTAGRAM", "g1"),
    ]);

    assert.deepEqual(
      groups.map((g) => g.key),
      ["post:solo", "group:g1"]
    );
  });

  it("groups a partial topic without inventing the missing channel", () => {
    // LinkedIn failed, so there is no LinkedIn record and none is implied.
    const groups = groupPostsByTopic([post("p1", "FACEBOOK", "g1"), post("p2", "INSTAGRAM", "g1")]);

    assert.equal(groups.length, 1);
    assert.deepEqual(
      groups[0].posts.map((p) => p.channel),
      ["FACEBOOK", "INSTAGRAM"]
    );
  });

  it("keys a group by its content group id, distinguishably from a post id", () => {
    const groups = groupPostsByTopic([post("p1", "FACEBOOK", "shared"), post("shared", "TIKTOK")]);

    // Both would be "shared" without the prefix, and the two cards would collide.
    assert.deepEqual(
      groups.map((g) => g.key),
      ["group:shared", "post:shared"]
    );
  });
});

describe("groupPostsByTopic — ungrouped posts stay as they were", () => {
  it("gives every null-group post its own card", () => {
    // The backward-compatibility guarantee: null is the ABSENCE of a topic, so
    // the whole back catalogue must not collapse into one card.
    const groups = groupPostsByTopic([
      post("p1", "FACEBOOK"),
      post("p2", "FACEBOOK"),
      post("p3", "INSTAGRAM"),
    ]);

    assert.equal(groups.length, 3);
    assert.ok(groups.every((g) => g.posts.length === 1));
    assert.ok(groups.every((g) => g.contentGroupId === null));
  });

  it("keeps ungrouped posts in the order they arrived", () => {
    const groups = groupPostsByTopic([post("p1", "FACEBOOK"), post("p2", "LINKEDIN")]);
    assert.deepEqual(
      groups.map((g) => g.posts[0].id),
      ["p1", "p2"]
    );
  });

  it("mixes old and new posts in one list without disturbing either", () => {
    const groups = groupPostsByTopic([
      post("old1", "FACEBOOK"),
      post("new1", "FACEBOOK", "g1"),
      post("new2", "INSTAGRAM", "g1"),
      post("old2", "LINKEDIN"),
    ]);

    assert.deepEqual(
      groups.map((g) => [g.key, g.posts.length]),
      [
        ["post:old1", 1],
        ["group:g1", 2],
        ["post:old2", 1],
      ]
    );
  });

  it("returns nothing for an empty list", () => {
    assert.deepEqual(groupPostsByTopic([]), []);
  });
});

describe("selectGroupPost", () => {
  const group = groupPostsByTopic([post("p1", "FACEBOOK", "g1"), post("p2", "INSTAGRAM", "g1")])[0];

  it("returns the selected version", () => {
    assert.equal(selectGroupPost(group, "p2").id, "p2");
  });

  it("defaults to the first version when nothing is selected", () => {
    assert.equal(selectGroupPost(group, null).id, "p1");
  });

  it("falls back when the selected version is gone", () => {
    // The ordinary consequence of deleting a sibling — not an edge case, and it
    // must not leave the card rendering nothing.
    assert.equal(selectGroupPost(group, "deleted").id, "p1");
  });

  it("returns the only post of an ungrouped card", () => {
    const solo = groupPostsByTopic([post("p9", "TIKTOK")])[0];
    assert.equal(selectGroupPost(solo, null).id, "p9");
    assert.equal(selectGroupPost(solo, "anything-else").id, "p9");
  });
});

describe("groupChannelVersions", () => {
  it("offers only the versions that exist", () => {
    const group = groupPostsByTopic([
      post("p1", "FACEBOOK", "g1"),
      post("p2", "INSTAGRAM", "g1"),
    ])[0];

    assert.deepEqual(groupChannelVersions(group), [
      { id: "p1", channel: "FACEBOOK" },
      { id: "p2", channel: "INSTAGRAM" },
    ]);
  });

  it("offers one version for an ungrouped post", () => {
    const solo = groupPostsByTopic([post("p9", "TIKTOK")])[0];
    assert.deepEqual(groupChannelVersions(solo), [{ id: "p9", channel: "TIKTOK" }]);
  });
});

describe("removePostFromGroup", () => {
  const group = groupPostsByTopic([post("p1", "FACEBOOK", "g1"), post("p2", "INSTAGRAM", "g1")])[0];

  it("keeps the topic when a sibling remains", () => {
    const left = removePostFromGroup(group, "p1");
    assert.ok(left);
    assert.deepEqual(
      left.posts.map((p) => p.id),
      ["p2"]
    );
    assert.equal(left.contentGroupId, "g1");
  });

  it("removes the card when the last version is deleted", () => {
    const solo = groupPostsByTopic([post("p9", "TIKTOK")])[0];
    assert.equal(removePostFromGroup(solo, "p9"), null);
  });

  it("leaves the group untouched when the id is not in it", () => {
    const left = removePostFromGroup(group, "not-here");
    assert.ok(left);
    assert.equal(left.posts.length, 2);
  });

  it("does not mutate the group it was given", () => {
    removePostFromGroup(group, "p1");
    assert.equal(group.posts.length, 2);
  });
});
