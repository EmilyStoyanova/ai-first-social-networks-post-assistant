import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  POST_STATUS_FILTERS,
  DEFAULT_POST_STATUS_FILTER,
  PENDING_APPROVAL_FILTER,
  pendingApprovalsHref,
  resolvePostStatusFilter,
  matchesPostStatusFilter,
  filterPostsByStatus,
  buildPostStatusQuery,
  resolvePostsEmptyState,
} from "./post-status-filter";
import type { PostStatusValue } from "./post-actions";

/**
 * The filter's whole job is deciding which posts disappear, so these tests are
 * written against every status the model has rather than a convenient subset —
 * a status that matches no filter is a post an owner can only reach by resetting
 * to "All posts", which is worth failing a test over.
 */

/** Every status in PostStatusValue. The annotation makes an omission a type error. */
const ALL_STATUSES: readonly PostStatusValue[] = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "SENT_TO_BUFFER",
  "PUBLISHED",
  "FAILED",
];

const POSTS = ALL_STATUSES.map((status) => ({ id: status.toLowerCase(), status }));

/** The statuses left visible by a filter, in ALL_STATUSES order. */
function visibleUnder(filter: (typeof POST_STATUS_FILTERS)[number]): string[] {
  return filterPostsByStatus(POSTS, filter).map((p) => p.status);
}

describe("resolvePostStatusFilter — default and fallback", () => {
  it("defaults to all posts when the param is absent", () => {
    assert.equal(resolvePostStatusFilter(undefined), "all");
    assert.equal(DEFAULT_POST_STATUS_FILTER, "all");
  });

  it("accepts each supported value", () => {
    for (const filter of POST_STATUS_FILTERS) {
      assert.equal(resolvePostStatusFilter(filter), filter);
    }
  });

  it("falls back to all for unrecognized values", () => {
    // A typo, a removed option, and a raw status value someone might guess at.
    assert.equal(resolvePostStatusFilter("publised"), "all");
    assert.equal(resolvePostStatusFilter("rejected"), "all");
    assert.equal(resolvePostStatusFilter("SENT_TO_BUFFER"), "all");
    assert.equal(resolvePostStatusFilter(""), "all");
    assert.equal(resolvePostStatusFilter("   "), "all");
  });

  it("tolerates casing and surrounding whitespace", () => {
    assert.equal(resolvePostStatusFilter("Published"), "published");
    assert.equal(resolvePostStatusFilter(" draft "), "draft");
  });

  it("takes the first value when the param is repeated", () => {
    // ?status=draft&status=published — Next hands this over as an array.
    assert.equal(resolvePostStatusFilter(["draft", "published"]), "draft");
    assert.equal(resolvePostStatusFilter([]), "all");
  });
});

describe("status mapping", () => {
  it("all posts hides nothing", () => {
    assert.deepEqual(visibleUnder("all"), [...ALL_STATUSES]);
  });

  it("published shows only what reached Buffer", () => {
    assert.deepEqual(visibleUnder("published"), ["SENT_TO_BUFFER", "PUBLISHED"]);
  });

  it("published excludes failed attempts", () => {
    // Publishing was tried and did not happen — the opposite of the answer this
    // filter is asked for.
    assert.equal(matchesPostStatusFilter("FAILED", "published"), false);
  });

  it("approved shows approved posts that have not gone out yet", () => {
    assert.deepEqual(visibleUnder("approved"), ["APPROVED"]);
  });

  it("approved excludes posts that were approved and then published", () => {
    // Otherwise "Approved" and "Published" would overlap and the two counts
    // would not add up for the user.
    assert.equal(matchesPostStatusFilter("SENT_TO_BUFFER", "approved"), false);
    assert.equal(matchesPostStatusFilter("PUBLISHED", "approved"), false);
  });

  it("drafts exclude posts already submitted for approval", () => {
    // Phase 4c: the two used to share a bucket. Now "Drafts" means work nobody
    // has been asked to look at, and a submitted post has left it.
    assert.deepEqual(visibleUnder("draft"), ["DRAFT"]);
  });

  it("pending approval is exactly the approval queue", () => {
    // This filter replaced the Approvals tab, so it must show what that queue
    // showed — listPosts(…, "pending_approval") — and nothing else.
    assert.deepEqual(visibleUnder("pending_approval"), ["PENDING_APPROVAL"]);
  });

  it("pending approval excludes posts already approved or rejected", () => {
    // The queue is what still needs a decision; a decided post has left it.
    assert.equal(matchesPostStatusFilter("APPROVED", "pending_approval"), false);
    assert.equal(matchesPostStatusFilter("REJECTED", "pending_approval"), false);
    assert.equal(matchesPostStatusFilter("DRAFT", "pending_approval"), false);
  });

  it("drafts exclude rejected posts", () => {
    // Rejection does not send the post back to draft, so it is a decision, not
    // unfinished work.
    assert.equal(matchesPostStatusFilter("REJECTED", "draft"), false);
  });

  it("puts every status in at most one non-all filter", () => {
    for (const status of ALL_STATUSES) {
      const matches = POST_STATUS_FILTERS.filter(
        (f) => f !== "all" && matchesPostStatusFilter(status, f)
      );
      assert.ok(matches.length <= 1, `${status} appears in ${matches.join(", ")}`);
    }
  });

  it("leaves rejected and failed reachable only under all posts", () => {
    // Documents a real gap rather than hiding it: these two have no filter of
    // their own, so "All posts" is the only way to see them.
    for (const status of ["REJECTED", "FAILED"] as const) {
      const matches = POST_STATUS_FILTERS.filter((f) => matchesPostStatusFilter(status, f));
      assert.deepEqual(matches, ["all"]);
    }
  });

  it("matches raw lowercase statuses too", () => {
    // listPosts uppercases, but a caller holding a Prisma row should not get a
    // silently empty grid.
    assert.equal(matchesPostStatusFilter("published", "published"), true);
    assert.equal(matchesPostStatusFilter("pending_approval", "pending_approval"), true);
  });

  it("does not mutate the list it is given", () => {
    const original = [...POSTS];
    filterPostsByStatus(POSTS, "draft");
    assert.deepEqual(POSTS, original);
  });
});

describe("buildPostStatusQuery — URL update", () => {
  it("writes the selected filter into the query string", () => {
    assert.equal(buildPostStatusQuery("", "published"), "status=published");
  });

  it("leaves a parameter it does not own untouched", () => {
    const query = buildPostStatusQuery("highlight=abc123", "approved");
    const params = new URLSearchParams(query);
    assert.equal(params.get("highlight"), "abc123");
    assert.equal(params.get("status"), "approved");
  });

  it("replaces a previous selection rather than appending one", () => {
    const query = buildPostStatusQuery("status=draft", "published");
    assert.deepEqual(new URLSearchParams(query).getAll("status"), ["published"]);
  });

  it("keeps all posts explicit in the URL", () => {
    // ?status=all is a stated requirement — a shared link should say what it is
    // showing rather than relying on the default.
    assert.equal(new URLSearchParams(buildPostStatusQuery("", "all")).get("status"), "all");
  });

  it("preserves unrelated params it does not own", () => {
    const query = buildPostStatusQuery("buffer=connected&highlight=abc123", "draft");
    const params = new URLSearchParams(query);
    assert.equal(params.get("buffer"), "connected");
    assert.equal(params.get("highlight"), "abc123");
  });

  it("round-trips through resolvePostStatusFilter", () => {
    for (const filter of POST_STATUS_FILTERS) {
      const params = new URLSearchParams(buildPostStatusQuery("", filter));
      assert.equal(resolvePostStatusFilter(params.get("status") ?? undefined), filter);
    }
  });
});

describe("pendingApprovalsHref — the retired Approvals tab's replacement", () => {
  it("points at the Posts page filtered to the approval queue", () => {
    assert.equal(pendingApprovalsHref("acme"), "/companies/acme/posts?status=pending_approval");
  });

  it("produces a link that resolves back to the pending filter", () => {
    // Guards the redirect contract end to end: if the param name or the filter
    // key ever drifts apart, the old /approval URLs land on an unfiltered grid.
    const query = pendingApprovalsHref("acme").split("?")[1];
    const raw = new URLSearchParams(query).get("status") ?? undefined;
    assert.equal(resolvePostStatusFilter(raw), PENDING_APPROVAL_FILTER);
  });

  it("counts the same posts the approval queue used to list", () => {
    // The Posts tab badge and the filter chip both read this predicate, which
    // is what keeps the two counts from disagreeing (§9.4).
    const pending = filterPostsByStatus(POSTS, PENDING_APPROVAL_FILTER);
    assert.deepEqual(
      pending.map((p) => p.status),
      ["PENDING_APPROVAL"]
    );
  });
});

describe("resolvePostsEmptyState", () => {
  it("asks the user to generate when the company has no posts at all", () => {
    assert.equal(resolvePostsEmptyState(0, 0), "no-posts");
  });

  it("reports zero results when a filter hides every post", () => {
    // The distinction matters: telling an owner with 12 posts that they have
    // none would read as data loss.
    assert.equal(resolvePostsEmptyState(12, 0), "no-matches");
  });

  it("shows the grid when anything matches", () => {
    assert.equal(resolvePostsEmptyState(12, 3), null);
  });

  it("reports zero results for a real filtered list", () => {
    const drafts = [{ id: "1", status: "DRAFT" }];
    const visible = filterPostsByStatus(drafts, "published");
    assert.equal(visible.length, 0);
    assert.equal(resolvePostsEmptyState(drafts.length, visible.length), "no-matches");
  });
});
