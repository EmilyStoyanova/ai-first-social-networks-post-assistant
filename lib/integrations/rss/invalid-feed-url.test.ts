import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidArticleUrl } from "./invalid-feed-url";

describe("isValidArticleUrl", () => {
  it("accepts absolute http(s) article URLs", () => {
    assert.equal(isValidArticleUrl("https://startupnation.com/grow/some-article/"), true);
    assert.equal(isValidArticleUrl("http://example.com/post?utm_source=rss&#038;utm_medium=x"), true);
  });

  it("rejects the old Mailchimp stylesheet URL from the parser bug", () => {
    assert.equal(
      isValidArticleUrl("//cdn-images.mailchimp.com/embedcode/classic-061523.css"),
      false
    );
  });

  it("rejects other bug-shaped, non-article URLs", () => {
    assert.equal(isValidArticleUrl("//cdn.example.com/app.js"), false); // protocol-relative asset
    assert.equal(isValidArticleUrl("/relative/path"), false); // relative
    assert.equal(isValidArticleUrl(""), false);
    assert.equal(isValidArticleUrl("not a url"), false);
  });

  it("rejects the synthetic non-RSS URLs (which the cleanup must never touch via RSS scope)", () => {
    // These are valid for prompt/calendar sources; the predicate flags them as
    // non-article, which is why the cleanup scopes to RSS sources before use.
    assert.equal(isValidArticleUrl("prompt:abc-123"), false);
    assert.equal(isValidArticleUrl("event:abc-123"), false);
  });
});
