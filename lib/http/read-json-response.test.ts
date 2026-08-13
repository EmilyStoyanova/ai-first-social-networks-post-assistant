import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonBody,
  readJsonResponse,
  bodySnippet,
  NON_JSON_RESPONSE_CODE,
  GATEWAY_TIMEOUT_CODE,
} from "./read-json-response";

/**
 * The body a serverless gateway returns when a function runs past its cap. This
 * exact text is what produced `Unexpected token 'A', "An error o"... is not
 * valid JSON` in the UI, so it is the fixture the fix is measured against.
 */
const GATEWAY_TIMEOUT_BODY = `An error occurred with this application.

FUNCTION_INVOCATION_TIMEOUT

ID: fra1::abcde-1700000000000-0123456789ab`;

describe("parseJsonBody — real JSON", () => {
  test("returns the API's own body untouched", () => {
    const body = parseJsonBody(201, JSON.stringify({ post: { id: "p1" }, failures: [] }));
    // Asserted before the deep-equal below, which narrows `body` to the literal.
    assert.equal(body.error, undefined);
    assert.deepEqual(body, { post: { id: "p1" }, failures: [] });
  });

  test("an API error body is passed through with its code intact", () => {
    const body = parseJsonBody(
      409,
      JSON.stringify({ error: { code: "CANNOT_GENERATE_UNIQUE_POST", attempts: 3 } })
    );
    assert.equal(body.error?.code, "CANNOT_GENERATE_UNIQUE_POST");
    // Diagnostics the UI reads must survive the parse.
    assert.equal(body.error?.attempts, 3);
  });
});

describe("parseJsonBody — the bug this fixes", () => {
  test("a gateway timeout page becomes a structured timeout error, not a throw", () => {
    // The whole point: this must not throw, and must not be mistaken for success.
    const body = parseJsonBody(500, GATEWAY_TIMEOUT_BODY);
    assert.equal(body.error?.code, GATEWAY_TIMEOUT_CODE);
  });

  test("the gateway's raw text is kept for diagnosis, on one line", () => {
    const body = parseJsonBody(500, GATEWAY_TIMEOUT_BODY);
    const raw = body.error?.body;
    assert.equal(typeof raw, "string");
    assert.ok((raw as string).includes("FUNCTION_INVOCATION_TIMEOUT"));
    assert.ok(!(raw as string).includes("\n"));
  });

  test("504 is a timeout whatever the body says", () => {
    assert.equal(
      parseJsonBody(504, "<html>Gateway Time-out</html>").error?.code,
      GATEWAY_TIMEOUT_CODE
    );
  });

  test("Task timed out (another platform's wording) is recognised", () => {
    assert.equal(
      parseJsonBody(502, "Task timed out after 10.01 seconds").error?.code,
      GATEWAY_TIMEOUT_CODE
    );
  });

  test("a non-JSON body that is NOT a timeout gets the unreachable code", () => {
    // A proxy's 502 page: also unparseable, but "try again" is the right advice
    // rather than "that was too much work", so it must not claim a timeout.
    const body = parseJsonBody(502, "<html><body><h1>502 Bad Gateway</h1></body></html>");
    assert.equal(body.error?.code, NON_JSON_RESPONSE_CODE);
  });

  test("an empty body is an error, never an empty success", () => {
    const body = parseJsonBody(500, "");
    assert.equal(body.error?.code, NON_JSON_RESPONSE_CODE);
    assert.equal(body.error?.body, "");
  });

  test("a bare JSON null does not read as a successful empty body", () => {
    // `JSON.parse("null")` succeeds, so a naive guard would let this through and
    // the caller would then read `json.error` off nothing.
    assert.equal(parseJsonBody(500, "null").error?.code, NON_JSON_RESPONSE_CODE);
  });

  test("a JSON array is not this API's shape", () => {
    assert.equal(parseJsonBody(200, "[1,2,3]").error?.code, NON_JSON_RESPONSE_CODE);
  });

  test("the status is carried on the synthesized error", () => {
    assert.equal(parseJsonBody(503, "upstream connect error").error?.status, 503);
  });
});

describe("bodySnippet", () => {
  test("collapses whitespace so a multi-line page logs on one line", () => {
    assert.equal(bodySnippet("a\n\n  b\tc "), "a b c");
  });

  test("truncates long bodies with an ellipsis", () => {
    const snippet = bodySnippet("x".repeat(500), 10);
    assert.equal(snippet, `${"x".repeat(10)}…`);
  });

  test("leaves a short body alone", () => {
    assert.equal(bodySnippet("short"), "short");
  });
});

describe("readJsonResponse", () => {
  test("parses a real Response", async () => {
    const res = new Response(JSON.stringify({ data: [1] }), { status: 200 });
    assert.deepEqual(await readJsonResponse(res), { data: [1] });
  });

  test("does not throw on a gateway body", async () => {
    const res = new Response(GATEWAY_TIMEOUT_BODY, { status: 500 });
    const body = await readJsonResponse(res);
    assert.equal(body.error?.code, GATEWAY_TIMEOUT_CODE);
  });

  test("a body that cannot be read at all still yields a structured error", async () => {
    // A connection dropped mid-body: `text()` rejects. The caller must still get
    // an object rather than an exception from the read itself.
    const broken = {
      status: 500,
      text: () => Promise.reject(new Error("network error")),
    } as unknown as Response;
    const body = await readJsonResponse(broken);
    assert.equal(body.error?.code, NON_JSON_RESPONSE_CODE);
  });
});
