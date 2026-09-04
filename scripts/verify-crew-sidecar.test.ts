import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { main, parseArgs, describe as describeErr } from "./verify-crew-sidecar";
import type { FetchLike } from "@/lib/ai/crew/crew-sidecar.client";
import type { CrewPostResponse } from "@/lib/ai/crew/crew-contract";

/**
 * The verifier's own tests.
 *
 * They exist because of a REAL defect: the first version of the script used
 * top-level `await`, and this repo's `package.json` declares no
 * `"type": "module"`, so `tsx` transforms these scripts to CommonJS — where a
 * top-level await cannot be expressed. It failed on macOS during
 * TRANSFORMATION, before issuing a single HTTP request, with
 * `Top-level await is currently not supported with the "cjs" output format`.
 *
 * The structural fix (every await inside `main()`, which returns an exit code
 * instead of calling `process.exit`) is what makes the script testable at all,
 * so the regression guard and the test suite arrive together. The load-bearing
 * property is simply that IMPORTING this module works and `main()` can be
 * called — under CJS, a reintroduced top-level await would fail the whole file
 * before a single test ran.
 */

const ENV = {
  CREW_SIDECAR_URL: "http://127.0.0.1:49510",
  CREW_SIDECAR_API_KEY: "test-key",
};

const FIXTURE = join(process.cwd(), "sidecar", "crewai", "fixtures", "request.json");

function passBody(overrides: Partial<CrewPostResponse> = {}): CrewPostResponse {
  return {
    status: "ok",
    candidate: { raw: '{"text":"A good post about the coast.","coreMessage":"A real claim."}' },
    qa: { finalDecision: "pass", revisions: 0, issues: [], routes: [] },
    agentCalls: { writer: 1, editor: 1, qa: 1 },
    latencyMs: 900,
    model: { tag: "qwen3.5:35b-a3b-q4_K_M", digest: "sha256:abc" },
    degradedStages: [],
    ...overrides,
  };
}

/** A sidecar double: healthy `/health`, 401 on a wrong key, scripted otherwise. */
function fakeSidecar(
  options: { post?: () => Response; health?: number; onCall?: (url: string) => void } = {}
): FetchLike {
  return async (url, init) => {
    options.onCall?.(url);
    if (url.endsWith("/health")) {
      return new Response("{}", { status: options.health ?? 200 });
    }
    const key = new Headers(init?.headers).get("x-worker-api-key");
    if (key === "wrong-key") return new Response("", { status: 401 });
    return options.post?.() ?? new Response(JSON.stringify(passBody()));
  };
}

// `main` prints a report; silence it so the test output stays readable.
const realLog = console.log;
beforeEach(() => {
  console.log = () => {};
});
afterEach(() => {
  console.log = realLog;
});

describe("parseArgs", () => {
  it("defaults to a non-live run with no timeout override", () => {
    assert.deepEqual(parseArgs([]), { live: false, timeoutOverride: undefined });
  });

  it("reads --live", () => {
    assert.equal(parseArgs(["--live"]).live, true);
  });

  it("reads --timeout", () => {
    assert.equal(parseArgs(["--timeout", "900000"]).timeoutOverride, 900_000);
  });

  it("reads the flags in either order", () => {
    assert.deepEqual(parseArgs(["--timeout", "5000", "--live"]), {
      live: true,
      timeoutOverride: 5000,
    });
  });

  it("IGNORES a malformed timeout rather than producing NaN", () => {
    // The previous implementation happened to be safe here (`NaN` is falsy, so
    // it was skipped). Made explicit so nobody "fixes" NaN into 0 — which would
    // abort every request instantly instead of using the real ceiling.
    for (const raw of ["abc", "", "-1", "0"]) {
      assert.equal(parseArgs(["--timeout", raw]).timeoutOverride, undefined, raw);
    }
  });

  it("ignores --timeout with no value after it", () => {
    assert.equal(parseArgs(["--timeout"]).timeoutOverride, undefined);
  });
});

describe("main — exit codes", () => {
  it("returns 1 and makes no request when the sidecar is not configured", async () => {
    let called = false;
    const code = await main([], {
      env: {},
      fetchImpl: async () => {
        called = true;
        return new Response("{}");
      },
      fixturePath: FIXTURE,
    });
    assert.equal(code, 1);
    // The point of the early return: nothing is dialled when nothing is configured.
    assert.equal(called, false);
  });

  it("returns 1 when only the URL is configured", async () => {
    const code = await main([], {
      env: { CREW_SIDECAR_URL: ENV.CREW_SIDECAR_URL },
      fixturePath: FIXTURE,
    });
    assert.equal(code, 1);
  });

  it("returns 0 for a healthy non-live run", async () => {
    const code = await main([], { env: ENV, fetchImpl: fakeSidecar(), fixturePath: FIXTURE });
    assert.equal(code, 0);
  });

  it("returns 1 when /health is not 200", async () => {
    const code = await main([], {
      env: ENV,
      fetchImpl: fakeSidecar({ health: 500 }),
      fixturePath: FIXTURE,
    });
    assert.equal(code, 1);
  });

  it("returns 1 when an unauthenticated POST is NOT refused", async () => {
    // A sidecar that serves an unauthenticated request is a real finding, so it
    // must fail the verifier rather than be reported as a note.
    const code = await main([], {
      env: ENV,
      fetchImpl: async (url) =>
        url.endsWith("/health")
          ? new Response("{}", { status: 200 })
          : new Response(JSON.stringify(passBody()), { status: 200 }),
      fixturePath: FIXTURE,
    });
    assert.equal(code, 1);
  });

  it("returns 1 when the fixture cannot be read, without throwing", async () => {
    const code = await main([], {
      env: ENV,
      fetchImpl: fakeSidecar(),
      fixturePath: join(process.cwd(), "sidecar", "crewai", "fixtures", "does-not-exist.json"),
    });
    assert.equal(code, 1);
  });

  it("does not leak failures between two runs in one process", async () => {
    // Why the tally is an object rather than a module-level `let`: a shared
    // counter would make the second run inherit the first's failures and every
    // exit code after the first would be meaningless.
    const bad = await main([], {
      env: ENV,
      fetchImpl: fakeSidecar({ health: 500 }),
      fixturePath: FIXTURE,
    });
    const good = await main([], { env: ENV, fetchImpl: fakeSidecar(), fixturePath: FIXTURE });
    assert.equal(bad, 1);
    assert.equal(good, 0);
  });
});

describe("main — the --live gate", () => {
  it("makes no /crew/post generation call without --live", async () => {
    const urls: string[] = [];
    await main([], {
      env: ENV,
      fetchImpl: fakeSidecar({ onCall: (u) => urls.push(u) }),
      fixturePath: FIXTURE,
    });
    // Exactly two: the health probe and the wrong-key auth probe. No generation,
    // and no serialization pair.
    assert.equal(urls.length, 2);
    assert.equal(urls.filter((u) => u.endsWith("/crew/post")).length, 1);
  });

  it("runs the generation and the serialization pair with --live", async () => {
    let posts = 0;
    const code = await main(["--live"], {
      env: ENV,
      fetchImpl: fakeSidecar({
        post: () => {
          posts++;
          // The live generation and the first of the concurrent pair succeed;
          // the third must be refused or the serialization check fails.
          return posts >= 3
            ? new Response("crew_busy", { status: 503 })
            : new Response(JSON.stringify(passBody()));
        },
      }),
      fixturePath: FIXTURE,
    });
    // 1 live generation + 2 concurrent = 3. The wrong-key auth probe is answered
    // 401 by the double before it reaches this script, so it is not counted.
    assert.equal(posts, 3);
    assert.equal(code, 0);
  });

  it("returns 1 when neither concurrent request is refused", async () => {
    const code = await main(["--live"], {
      env: ENV,
      fetchImpl: fakeSidecar({ post: () => new Response(JSON.stringify(passBody())) }),
      fixturePath: FIXTURE,
    });
    assert.equal(code, 1);
  });

  it("returns 1 when the live run reports a degraded QA with no stage named", async () => {
    // An inconsistent report is a contract problem: `unavailable` means a stage
    // did not complete, so it must say which.
    const code = await main(["--live"], {
      env: ENV,
      fetchImpl: fakeSidecar({
        post: () =>
          new Response(
            JSON.stringify(
              passBody({
                qa: { finalDecision: "unavailable", revisions: 0, issues: [], routes: [] },
                agentCalls: { writer: 1, editor: 1, qa: 0 },
                degradedStages: [],
              })
            )
          ),
      }),
      fixturePath: FIXTURE,
    });
    assert.equal(code, 1);
  });

  it("returns 1 when the sidecar's counters show a bypassed Editor", async () => {
    // Requirement 6, reaching the verifier through the real client's own
    // `validateCallCounts` rather than a re-check here.
    const code = await main(["--live"], {
      env: ENV,
      fetchImpl: fakeSidecar({
        post: () =>
          new Response(
            JSON.stringify(
              passBody({
                qa: { finalDecision: "pass", revisions: 1, issues: [], routes: ["writer"] },
                agentCalls: { writer: 2, editor: 1, qa: 2 },
              })
            )
          ),
      }),
      fixturePath: FIXTURE,
    });
    assert.equal(code, 1);
  });

  it("returns 1 when the candidate does not parse as a post", async () => {
    const code = await main(["--live"], {
      env: ENV,
      fetchImpl: fakeSidecar({
        post: () =>
          new Response(
            JSON.stringify(passBody({ candidate: { raw: "I think this would be lovely." } }))
          ),
      }),
      fixturePath: FIXTURE,
    });
    assert.equal(code, 1);
  });

  it("honours --timeout by handing it to the client", async () => {
    // A 1ms budget cannot survive a real await, so the generation aborts and the
    // run fails — which is exactly how the Mac procedure verifies the timeout
    // mapping (README.md step 8).
    const code = await main(["--live", "--timeout", "1"], {
      env: ENV,
      fetchImpl: async (url, init) => {
        if (url.endsWith("/health")) return new Response("{}", { status: 200 });
        const key = new Headers(init?.headers).get("x-worker-api-key");
        if (key === "wrong-key") return new Response("", { status: 401 });
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (init?.signal?.aborted) {
          const err = new Error("aborted");
          err.name = "TimeoutError";
          throw err;
        }
        return new Response(JSON.stringify(passBody()));
      },
      fixturePath: FIXTURE,
    });
    assert.equal(code, 1);
  });
});

describe("describe(err)", () => {
  it("names the error and its cause", () => {
    const err = new TypeError("fetch failed");
    err.cause = new Error("connect ECONNREFUSED 127.0.0.1:49510");
    assert.equal(
      describeErr(err),
      "TypeError: fetch failed (connect ECONNREFUSED 127.0.0.1:49510)"
    );
  });

  it("stringifies a non-error", () => {
    assert.equal(describeErr("boom"), "boom");
  });
});
