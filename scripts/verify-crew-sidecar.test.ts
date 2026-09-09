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
    candidate: {
      raw: '{"text":"A good post about the coast.","coreMessage":"A real claim."}',
      json: {
        text: "A good post about the coast.",
        hashtags: [],
        coreMessage: "A real claim.",
      },
    },
    qa: { finalDecision: "pass", revisions: 0, issues: [], routes: [] },
    agentCalls: { writer: 1, editor: 1, qa: 1 },
    latencyMs: 900,
    model: { tag: "qwen3.5:35b-a3b-q4_K_M", digest: "sha256:abc" },
    degradedStages: [],
    ...overrides,
  };
}

/**
 * A sidecar double: healthy `/health`, 401 on a wrong key, scripted otherwise.
 *
 * `/health` now carries the single-flight state, and the double models it the
 * way the real sidecar behaves: BUSY while a generation is in flight. That is
 * what lets the serialization checks run without a real sidecar — and it is why
 * `busyWhileGenerating: false` (below) reproduces a sidecar whose occupancy is
 * invisible.
 */
function fakeSidecar(
  options: {
    /** The ADMITTED generation's response. Overlapping probes are separate. */
    post?: () => Response;
    health?: number;
    healthBody?: unknown;
    onCall?: (url: string) => void;
    /**
     * What an overlapping generation gets. `refuse` is a correct sidecar;
     * `admit` is one with broken admission control; `refuse-always` is the
     * observed abandoned-run state where even the FIRST request is refused.
     */
    overlap?: "refuse" | "admit" | "refuse-always";
    /** Omit `busy` from /health, as an un-upgraded sidecar would. */
    reportsBusy?: boolean;
  } = {}
): FetchLike {
  let inFlight = 0;
  const busyBody = () =>
    new Response(
      JSON.stringify({ status: "error", code: "unavailable", message: "crew_busy (running)" }),
      { status: 503 }
    );

  return async (url, init) => {
    options.onCall?.(url);
    if (url.endsWith("/health")) {
      const occupied = inFlight > 0 || options.overlap === "refuse-always";
      const body =
        options.healthBody ??
        (options.reportsBusy === false
          ? { status: "ok" }
          : {
              status: "ok",
              busy: occupied,
              runningForMs: occupied ? 1234 : null,
              clientDisconnected: false,
            });
      return new Response(JSON.stringify(body), { status: options.health ?? 200 });
    }
    const key = new Headers(init?.headers).get("x-worker-api-key");
    if (key === "wrong-key") return new Response("", { status: 401 });
    if (options.overlap === "refuse-always") return busyBody();
    if (inFlight > 0 && options.overlap !== "admit") return busyBody();
    inFlight++;
    try {
      // Real asynchrony, so the admitted generation is genuinely still in
      // flight when the verifier polls /health and fires the overlap.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return options.post?.() ?? new Response(JSON.stringify(passBody()));
    } finally {
      inFlight--;
    }
  };
}

/** No real waiting between the verifier's /health polls. */
const noSleep = async (): Promise<void> => {};

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
          ? new Response(JSON.stringify({ status: "ok", busy: false }), { status: 200 })
          : new Response(JSON.stringify(passBody()), { status: 200 }),
      fixturePath: FIXTURE,
    });
    assert.equal(code, 1);
  });

  it("returns 1 when /health does not match the health contract", async () => {
    // `{}` has no `status`, so this sidecar is not answering the endpoint the
    // verifier reads occupancy from. Refused rather than treated as healthy.
    const code = await main([], {
      env: ENV,
      fetchImpl: fakeSidecar({ healthBody: {} }),
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

  it("passes when one request is admitted, the overlap refused, and the result returned", async () => {
    const code = await main(["--live"], {
      env: ENV,
      fetchImpl: fakeSidecar({ overlap: "refuse" }),
      sleep: noSleep,
      fixturePath: FIXTURE,
    });
    assert.equal(code, 0);
  });

  it("returns 1 when the overlapping request is ADMITTED instead of refused", async () => {
    // Broken admission control: two generations would hit the same local Ollama
    // at once, which is the thing single-flight exists to prevent.
    const code = await main(["--live"], {
      env: ENV,
      fetchImpl: fakeSidecar({ overlap: "admit" }),
      sleep: noSleep,
      fixturePath: FIXTURE,
    });
    assert.equal(code, 1);
  });
});

describe("main — serialization is no longer satisfied by 503 + 503", () => {
  /**
   * THE regression guard for the reported defect.
   *
   * On the Mac, undici abandoned a live request at its own 300s headers
   * timeout. The generation was never cancelled, so the slot stayed held and
   * BOTH of the verifier's concurrent probes came back 503 — and the old check
   * ("either status is 503") called that a serialization PASS.
   */
  it("FAILS when every request is refused because an abandoned run holds the slot", async () => {
    const code = await main(["--live"], {
      env: ENV,
      fetchImpl: fakeSidecar({ overlap: "refuse-always" }),
      sleep: noSleep,
      fixturePath: FIXTURE,
    });
    assert.equal(code, 1, "503 + 503 must never pass");
  });

  it("does not even attempt the live run when /health already reports busy", async () => {
    // The occupied sidecar is reported as itself. Running the generation anyway
    // would collect a `crew_busy` failure and blame this run for it.
    const posts: string[] = [];
    const code = await main(["--live"], {
      env: ENV,
      fetchImpl: fakeSidecar({
        overlap: "refuse-always",
        onCall: (url) => {
          if (url.endsWith("/crew/post")) posts.push(url);
        },
      }),
      sleep: noSleep,
      fixturePath: FIXTURE,
    });
    assert.equal(code, 1);
    // Only the wrong-key auth probe from the reachability section — no generation.
    assert.equal(posts.length, 1);
  });

  it("FAILS, rather than passing quietly, when occupancy can never be observed", async () => {
    // A sidecar that admits the request but never reports `busy` leaves the
    // overlap unproven. Unproven is a failure, not a skip: this is the exact
    // blind spot that let 503 + 503 look like a pass.
    const code = await main(["--live"], {
      env: ENV,
      fetchImpl: fakeSidecar({ overlap: "refuse", reportsBusy: false }),
      sleep: noSleep,
      fixturePath: FIXTURE,
    });
    assert.equal(code, 1);
  });

  it("returns 1 when the live run reports a degraded QA with no stage named", async () => {
    // An inconsistent report is a contract problem: `unavailable` means a stage
    // did not complete, so it must say which.
    const code = await main(["--live"], {
      env: ENV,
      sleep: noSleep,
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
      sleep: noSleep,
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

  it("returns 1 when the structured candidate is not a valid post", async () => {
    // A candidate whose `json` breaks `LlmPostSchema` is refused by the client
    // as invalid_response — the verifier must surface that as a failure, not a
    // pass. (A raw string that "does not parse" can no longer even reach here:
    // the sidecar validates before returning.)
    const code = await main(["--live"], {
      env: ENV,
      sleep: noSleep,
      fetchImpl: fakeSidecar({
        post: () =>
          new Response(
            JSON.stringify(
              passBody({
                candidate: {
                  raw: "I think this would be lovely.",
                  json: { text: "", hashtags: [], coreMessage: "x" } as never,
                },
              })
            )
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
    let healthCalls = 0;
    const code = await main(["--live", "--timeout", "1"], {
      env: ENV,
      sleep: noSleep,
      fetchImpl: async (url, init) => {
        if (url.endsWith("/health")) {
          // Idle for the precondition, then busy — otherwise the verifier would
          // (correctly) refuse to start a live run at all and the timeout path
          // would never be reached.
          healthCalls++;
          return new Response(
            JSON.stringify({ status: "ok", busy: healthCalls > 1, runningForMs: 5 }),
            { status: 200 }
          );
        }
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
