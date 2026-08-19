import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  excerpt,
  MAX_STRING_CHARS,
  redactSecretsInString,
  REDACTED,
  sanitizeForTrace,
} from "./redact";

describe("sanitizeForTrace — secrets by key", () => {
  it("removes a string under a secret-sounding key", () => {
    const { value } = sanitizeForTrace({
      apiKey: "abcdef0123456789",
      api_key: "abcdef0123456789",
      authorization: "Basic dXNlcjpwYXNz",
      cookie: "session=abc",
      password: "hunter2",
      clientSecret: "s3cr3t",
      DATABASE_URL: "postgresql://u:p@host/db",
    });

    for (const [key, redacted] of Object.entries(value as Record<string, unknown>)) {
      assert.equal(redacted, REDACTED, `${key} should be redacted`);
    }
  });

  it("keeps NUMERIC token accounting, which is the whole point of the trace", () => {
    // The redactor matches "token" by name. If it matched numbers too it would
    // blank exactly the usage figures somebody opens a trace to read.
    const { value } = sanitizeForTrace({
      maxTokens: 1024,
      promptTokens: 812,
      tokenUsage: { completion: 210, prompt: 812 },
      // …while a token VALUE, which is a string, still goes.
      accessToken: "ya29.a0AfH6SMB-not-a-real-token",
    });

    const out = value as Record<string, unknown>;
    assert.equal(out.maxTokens, 1024);
    assert.equal(out.promptTokens, 812);
    assert.deepEqual(out.tokenUsage, { completion: 210, prompt: 812 });
    assert.equal(out.accessToken, REDACTED);
  });

  it("removes a whole ARRAY under a secret key", () => {
    const { value } = sanitizeForTrace({ apiKeys: ["one", "two"] });
    assert.equal((value as Record<string, unknown>).apiKeys, REDACTED);
  });
});

describe("sanitizeForTrace — secrets by shape", () => {
  it("removes credential shapes from any string, including a prompt", () => {
    const prompt = [
      "Write a post. Use sk-abcdefghijklmnopqrstuvwx to authenticate.",
      "Header: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl",
      "Fetch https://api.example.com/v1/items?api_key=zzzzzzzzzzzzzzzz&page=2",
      "Connect to postgresql://admin:hunter2@db.example.com/app",
    ].join("\n");

    const { value } = sanitizeForTrace({ userPrompt: prompt });
    const out = (value as Record<string, string>).userPrompt;

    assert.ok(!out.includes("sk-abcdefghijklmnopqrstuvwx"), "provider key survived");
    assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9"), "JWT survived");
    assert.ok(!out.includes("zzzzzzzzzzzzzzzz"), "query-parameter key survived");
    assert.ok(!out.includes("hunter2"), "inline URL password survived");
    // The surrounding prose — the part that makes the prompt readable — stays.
    assert.ok(out.includes("Write a post."));
    assert.ok(out.includes("page=2"), "the harmless query parameter was mangled");
  });

  it("leaves ordinary prose completely alone", () => {
    const text = "The bathroom mixer range now ships in brushed brass. Read more at example.com.";
    assert.equal(redactSecretsInString(text), text);
  });
});

describe("sanitizeForTrace — size and shape safety", () => {
  it("caps a very long string and reports the truncation", () => {
    const long = "x".repeat(MAX_STRING_CHARS + 500);
    const { value, truncated } = sanitizeForTrace({ text: long });
    const out = (value as Record<string, string>).text;

    assert.equal(truncated, true);
    assert.ok(out.length < long.length);
    assert.ok(out.includes("truncated"));
  });

  it("does NOT report truncation when nothing was shortened", () => {
    const { truncated } = sanitizeForTrace({ text: "short", n: 1 });
    assert.equal(truncated, false);
  });

  it("survives a circular structure instead of throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const { value } = sanitizeForTrace(a);
    assert.equal((value as Record<string, unknown>).name, "a");
    assert.equal((value as Record<string, unknown>).self, "[circular]");
  });

  it("survives a getter that throws", () => {
    const hostile = {
      get boom(): string {
        throw new Error("nope");
      },
      fine: 1,
    };
    const { value } = sanitizeForTrace(hostile);
    // The object is still represented; nothing propagates to the caller.
    assert.ok(value !== undefined);
  });

  it("renders dates as ISO strings so a trace stays JSON", () => {
    const when = new Date("2026-03-01T10:00:00.000Z");
    const { value } = sanitizeForTrace({ when });
    assert.equal((value as Record<string, unknown>).when, "2026-03-01T10:00:00.000Z");
  });
});

describe("excerpt", () => {
  it("shortens and redacts", () => {
    const text = `secret sk-abcdefghijklmnopqrstuvwx then ${"y".repeat(1000)}`;
    const out = excerpt(text, 100);
    assert.ok(out !== null);
    assert.ok(out.length <= 101);
    assert.ok(!out.includes("sk-abcdefghijklmnopqrstuvwx"));
  });

  it("returns null for a missing value", () => {
    assert.equal(excerpt(null), null);
    assert.equal(excerpt(undefined), null);
  });
});
