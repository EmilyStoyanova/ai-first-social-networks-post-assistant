import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CrewSidecarClient,
  CrewSidecarError,
  crewSidecarCeilingMs,
  crewSidecarConfigFromEnv,
  isLoopbackUrl,
  type FetchLike,
} from "./crew-sidecar.client";
import type { CrewPostRequest, CrewPostResponse } from "./crew-contract";

const LOOPBACK = { url: "http://127.0.0.1:49510", apiKey: "secret-key" };

function request(overrides: Partial<CrewPostRequest["attemptContext"]> = {}): CrewPostRequest {
  return {
    articleUnderstanding: {
      mainSubject: "A protest over coastal development",
      centralThesis: null,
      centralConflict: null,
      articleType: "news",
      secondaryTopics: [],
      incidentalTopics: [],
      entities: [],
      confidence: 0.8,
      source: "understanding",
    },
    platform: "facebook",
    language: "bg",
    brandContext: {
      companyName: "Acme",
      companyDescription: null,
      toneOfVoice: null,
      targetAudience: null,
      forbiddenWords: [],
    },
    generationRequirements: {
      systemPrompt: "sys",
      userPrompt: "user",
      maxTextLength: 2000,
      responseContract: "llm_post_json",
    },
    inferenceConfig: {
      model: "qwen3.5:35b-a3b-q4_K_M",
      baseUrl: "http://127.0.0.1:11434",
      temperature: 0.85,
    },
    attemptContext: {
      attempt: 1,
      maxAttempts: 3,
      maxQaRounds: 2,
      previousRejection: null,
      ...overrides,
    },
  };
}

function ok(body: unknown, status = 200): FetchLike {
  return async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function passBody(overrides: Partial<CrewPostResponse> = {}): CrewPostResponse {
  return {
    status: "ok",
    candidate: { raw: '{"text":"a post","coreMessage":"a claim"}' },
    qa: { finalDecision: "pass", revisions: 0, issues: [], routes: [] },
    agentCalls: { writer: 1, editor: 1, qa: 1 },
    latencyMs: 900,
    model: { tag: "qwen3.5:35b-a3b-q4_K_M", digest: "sha256:abc" },
    degradedStages: [],
    ...overrides,
  };
}

describe("isLoopbackUrl", () => {
  it("accepts the loopback literals", () => {
    for (const u of ["http://127.0.0.1:49510", "http://localhost:49510", "http://[::1]:49510"]) {
      assert.equal(isLoopbackUrl(u), true, u);
    }
  });

  it("refuses anything that could resolve off-box", () => {
    for (const u of [
      "http://10.0.0.5:49510",
      "http://sidecar.internal:49510",
      "https://crew.example.com",
      // 0.0.0.0 is a bind wildcard, never a loopback DESTINATION.
      "http://0.0.0.0:49510",
      "http://127.0.0.1.evil.com",
      "not a url",
    ]) {
      assert.equal(isLoopbackUrl(u), false, u);
    }
  });

  it("refuses a non-http scheme", () => {
    assert.equal(isLoopbackUrl("file:///etc/passwd"), false);
  });
});

describe("configuration", () => {
  it("refuses to construct against a non-loopback URL, without dialling it", () => {
    let called = false;
    const spy: FetchLike = async () => {
      called = true;
      return new Response("{}");
    };
    assert.throws(
      () => new CrewSidecarClient({ url: "https://crew.example.com", apiKey: "k" }, spy),
      (err: unknown) => err instanceof CrewSidecarError && err.code === "not_configured"
    );
    // The whole point of refusing at construction: no outbound request happened.
    assert.equal(called, false);
  });

  it("fromEnv throws not_configured rather than returning null", () => {
    // A nullable return would invite `?? singleAgent`, which is the fallback the
    // design forbids.
    assert.throws(
      () => CrewSidecarClient.fromEnv({}),
      (err: unknown) => err instanceof CrewSidecarError && err.code === "not_configured"
    );
  });

  it("fromEnv throws when the URL is set but the key is not", () => {
    assert.throws(
      () => CrewSidecarClient.fromEnv({ CREW_SIDECAR_URL: LOOPBACK.url }),
      (err: unknown) => err instanceof CrewSidecarError && err.code === "not_configured"
    );
  });

  it("crewSidecarConfigFromEnv ignores a malformed timeout instead of using NaN", () => {
    const config = crewSidecarConfigFromEnv({
      CREW_SIDECAR_URL: LOOPBACK.url,
      CREW_SIDECAR_API_KEY: "k",
      CREW_SIDECAR_TIMEOUT_MS: "not-a-number",
    });
    assert.equal(config?.timeoutMs, undefined);
  });

  it("the ceiling is 3+3R Ollama calls, not 3+2R", () => {
    // The worst case is all-writer-routed, because every writer revision is
    // followed by an editor pass.
    assert.equal(crewSidecarCeilingMs(0), 3 * 300_000);
    assert.equal(crewSidecarCeilingMs(2), 9 * 300_000);
  });
});

describe("the request on the wire", () => {
  it("sends the api key header and posts to /crew/post", async () => {
    let seenUrl = "";
    let seenKey: string | null = null;
    const client = new CrewSidecarClient(LOOPBACK, async (url, init) => {
      seenUrl = url;
      seenKey = new Headers(init?.headers).get("x-worker-api-key");
      return new Response(JSON.stringify(passBody()));
    });
    await client.generate(request());
    assert.equal(seenUrl, "http://127.0.0.1:49510/crew/post");
    assert.equal(seenKey, "secret-key");
  });

  it("tolerates a trailing slash on the configured URL", async () => {
    let seenUrl = "";
    const client = new CrewSidecarClient(
      { ...LOOPBACK, url: "http://127.0.0.1:49510/" },
      async (url) => {
        seenUrl = url;
        return new Response(JSON.stringify(passBody()));
      }
    );
    await client.generate(request());
    assert.equal(seenUrl, "http://127.0.0.1:49510/crew/post");
  });
});

describe("successful outcomes", () => {
  it("returns the candidate and the QA state on a pass", async () => {
    const client = new CrewSidecarClient(LOOPBACK, ok(passBody()));
    const outcome = await client.generate(request());
    assert.equal(outcome.qaState, "pass");
    assert.equal(outcome.qaRevisions, 0);
    assert.deepEqual(outcome.agentCalls, { writer: 1, editor: 1, qa: 1 });
    assert.equal(outcome.model.tag, "qwen3.5:35b-a3b-q4_K_M");
  });

  it("returns an unavailable QA as a DEGRADED success, never as a pass", async () => {
    // Requirement 7. A QA that could not be parsed is reported as unavailable
    // on a 200, and the candidate survives — marked degraded.
    const client = new CrewSidecarClient(
      LOOPBACK,
      ok(
        passBody({
          qa: { finalDecision: "unavailable", revisions: 0, issues: [], routes: [] },
          agentCalls: { writer: 1, editor: 1, qa: 0 },
          degradedStages: ["qa"],
        })
      )
    );
    const outcome = await client.generate(request());
    assert.equal(outcome.qaState, "unavailable");
    assert.notEqual(outcome.qaState, "pass");
    assert.deepEqual([...outcome.degradedStages], ["qa"]);
  });

  it("returns rejected_unroutable as a successful call with a refusing verdict", async () => {
    // The CALL succeeded; the verdict is what refuses. Classifying it as a
    // transport failure here would lose the distinction the taxonomy exists for.
    const client = new CrewSidecarClient(
      LOOPBACK,
      ok(
        passBody({
          qa: {
            finalDecision: "rejected_unroutable",
            revisions: 0,
            issues: [{ dimension: "vibes", severity: "unknown", detail: "off" }],
            routes: [],
          },
        })
      )
    );
    const outcome = await client.generate(request());
    assert.equal(outcome.qaState, "rejected_unroutable");
  });
});

describe("failures are explicit", () => {
  it("maps an abort to timeout", async () => {
    const client = new CrewSidecarClient(LOOPBACK, async () => {
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    });
    await assert.rejects(
      client.generate(request()),
      (err: unknown) => err instanceof CrewSidecarError && err.code === "timeout"
    );
  });

  it("maps a refused connection to unavailable, and never echoes the host", async () => {
    const client = new CrewSidecarClient(LOOPBACK, async () => {
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = Object.assign(
        new Error("connect ECONNREFUSED 127.0.0.1:49510"),
        { code: "ECONNREFUSED" }
      );
      throw err;
    });
    await assert.rejects(client.generate(request()), (err: unknown) => {
      assert.ok(err instanceof CrewSidecarError);
      assert.equal(err.code, "unavailable");
      // The short syscall code is useful and safe; the host and port are not.
      assert.match(err.message, /ECONNREFUSED/);
      assert.doesNotMatch(err.message, /127\.0\.0\.1/);
      assert.doesNotMatch(err.message, /49510/);
      return true;
    });
  });

  it("maps 503 crew_busy to unavailable — a clean, retryable serialization signal", async () => {
    const client = new CrewSidecarClient(
      LOOPBACK,
      async () => new Response("crew_busy", { status: 503 })
    );
    await assert.rejects(
      client.generate(request()),
      (err: unknown) => err instanceof CrewSidecarError && err.code === "unavailable"
    );
  });

  it("preserves a declared failure code from an error body", async () => {
    const client = new CrewSidecarClient(
      LOOPBACK,
      ok({ status: "error", code: "qa_parse_error", message: "QA reply was not JSON" }, 200)
    );
    await assert.rejects(client.generate(request()), (err: unknown) => {
      assert.ok(err instanceof CrewSidecarError);
      // Flattening this to invalid_response would lose the reason a policy
      // decision depends on.
      assert.equal(err.code, "qa_parse_error");
      return true;
    });
  });

  it("preserves a declared failure code sent with a 5xx status", async () => {
    const client = new CrewSidecarClient(
      LOOPBACK,
      async () =>
        new Response(JSON.stringify({ status: "error", code: "non_converged" }), { status: 500 })
    );
    await assert.rejects(
      client.generate(request()),
      (err: unknown) => err instanceof CrewSidecarError && err.code === "non_converged"
    );
  });

  it("maps a non-JSON body to invalid_response", async () => {
    const client = new CrewSidecarClient(LOOPBACK, async () => new Response("<html>oops</html>"));
    await assert.rejects(
      client.generate(request()),
      (err: unknown) => err instanceof CrewSidecarError && err.code === "invalid_response"
    );
  });

  it("maps an off-contract body to invalid_response", async () => {
    const client = new CrewSidecarClient(LOOPBACK, ok({ status: "ok", candidate: { raw: "x" } }));
    await assert.rejects(
      client.generate(request()),
      (err: unknown) => err instanceof CrewSidecarError && err.code === "invalid_response"
    );
  });

  it("maps a mid-loop verdict to non_converged", async () => {
    const client = new CrewSidecarClient(
      LOOPBACK,
      ok(
        passBody({
          qa: { finalDecision: "revise_editor", revisions: 1, issues: [], routes: ["editor"] },
          agentCalls: { writer: 1, editor: 2, qa: 2 },
        })
      )
    );
    await assert.rejects(
      client.generate(request()),
      (err: unknown) => err instanceof CrewSidecarError && err.code === "non_converged"
    );
  });

  it("REFUSES a run whose counters show the Editor was bypassed", async () => {
    // A Flow regression is caught by the client, not discovered later in the
    // output. It is invalid_response — the contract is broken, not the post.
    const client = new CrewSidecarClient(
      LOOPBACK,
      ok(
        passBody({
          qa: { finalDecision: "pass", revisions: 1, issues: [], routes: ["writer"] },
          agentCalls: { writer: 2, editor: 1, qa: 2 },
        })
      )
    );
    await assert.rejects(client.generate(request()), (err: unknown) => {
      assert.ok(err instanceof CrewSidecarError);
      assert.equal(err.code, "invalid_response");
      assert.match(err.message, /Editor was bypassed/);
      return true;
    });
  });

  it("REFUSES a run that exceeded the maxQaRounds it was given", async () => {
    const client = new CrewSidecarClient(
      LOOPBACK,
      ok(
        passBody({
          qa: { finalDecision: "pass", revisions: 2, issues: [], routes: ["editor", "editor"] },
          agentCalls: { writer: 1, editor: 3, qa: 3 },
        })
      )
    );
    // The caller allowed ONE round; the sidecar reports two.
    await assert.rejects(
      client.generate(request({ maxQaRounds: 1 })),
      (err: unknown) => err instanceof CrewSidecarError && err.code === "invalid_response"
    );
  });
});
