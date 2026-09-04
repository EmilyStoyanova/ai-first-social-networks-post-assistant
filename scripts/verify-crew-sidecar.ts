/**
 * "Does the running CrewAI sidecar satisfy the contract the app will hold it to?"
 *
 * Answers it through the SAME code path production takes — the real
 * `CrewSidecarClient`, the real strict response schema, the real
 * `validateCallCounts` and the real `resolveQaState` — rather than by curling
 * the endpoint and eyeballing the JSON. A hand-checked response proves only
 * that a human found it reasonable; this proves the shipped parser accepts it.
 *
 * Touches no database, claims no feed item and writes nothing. Safe to run at
 * any time, including against production configuration.
 *
 * Usage, from the repo root ON THE MAC (the sidecar is loopback-only):
 *
 *   npm run crew:verify                 # config + reachability, no model call
 *   npm run crew:verify -- --live       # also runs the fixture through Qwen
 *   npm run crew:verify -- --live --timeout 900000
 *
 * `--live` spends real model time: one full Writer → Editor → QA pass, which at
 * R=0 is three Ollama calls. Expect minutes, not seconds.
 *
 * ── Why this file has no top-level await ────────────────────────────────────
 *
 * This repo's `package.json` declares no `"type": "module"`, so `tsx`
 * transforms these scripts to CommonJS — and a top-level `await` cannot be
 * expressed in CJS output. An earlier version of this file used one and failed
 * on macOS during TRANSFORMATION, before it made a single HTTP request:
 * `Top-level await is currently not supported with the "cjs" output format`.
 *
 * So every `await` lives inside `main()`, which returns an exit CODE rather
 * than calling `process.exit` itself. That is what makes the whole verifier
 * testable — a test can run `main()` with an injected `fetch` and assert the
 * code — and it is also why the module-level body is now inert on import.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  CrewSidecarClient,
  CrewSidecarError,
  crewSidecarCeilingMs,
  crewSidecarConfigFromEnv,
  isLoopbackUrl,
  type FetchLike,
} from "@/lib/ai/crew/crew-sidecar.client";
import type { CrewPostRequest } from "@/lib/ai/crew/crew-contract";
import { parseLlmPost } from "@/lib/ai/parse-llm-post";
import { inferenceFingerprint } from "@/lib/ai/crew/provenance";

// ─── Arguments ────────────────────────────────────────────────────────────────

export interface VerifyArgs {
  live: boolean;
  /** ms, or undefined to use the configured/compile-time timeout. */
  timeoutOverride: number | undefined;
}

/**
 * Parses the flags.
 *
 * A malformed or non-positive `--timeout` is IGNORED rather than rejected,
 * which is what the previous implementation did (`Number("abc")` is `NaN`, and
 * `NaN` is falsy, so it was already skipped silently). Making that explicit
 * preserves the behaviour and stops a future reader from "fixing" NaN into a
 * zero-length timeout, which would abort every request instantly.
 */
export function parseArgs(argv: readonly string[]): VerifyArgs {
  const timeoutFlag = argv.indexOf("--timeout");
  const raw = timeoutFlag !== -1 ? argv[timeoutFlag + 1] : undefined;
  const parsed = raw === undefined ? NaN : Number(raw);
  return {
    live: argv.includes("--live"),
    timeoutOverride: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
  };
}

// ─── Reporting ────────────────────────────────────────────────────────────────

/**
 * The running tally, as an object rather than a module-level `let`.
 *
 * Module state would be shared between two `main()` calls in one process, which
 * is exactly what the tests do — the second run would inherit the first's
 * failures and the exit codes would stop meaning anything.
 */
class Report {
  private failures = 0;

  pass(label: string, detail = ""): void {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  }

  fail(label: string, detail: string): void {
    this.failures++;
    console.log(`  FAIL  ${label} — ${detail}`);
  }

  check(label: string, condition: boolean, detail = ""): void {
    if (condition) this.pass(label, detail);
    else this.fail(label, detail || "condition not met");
  }

  info(message: string): void {
    console.log(`  INFO  ${message}`);
  }

  note(message: string): void {
    console.log(`  NOTE  ${message}`);
  }

  /** The process exit code, and the closing banner. */
  summarize(): number {
    console.log("\n───────────────────────────────────────────────────────────────");
    if (this.failures === 0) {
      console.log("  ALL CHECKS PASSED\n");
      return 0;
    }
    console.log(`  ${this.failures} CHECK(S) FAILED\n`);
    return 1;
  }
}

export interface VerifyDeps {
  /** Defaults to `process.env`. Injected so a test needs no real configuration. */
  env?: Record<string, string | undefined>;
  /** Defaults to global `fetch`, and is handed to the real client unchanged. */
  fetchImpl?: FetchLike;
  /** Defaults to the repo's shared fixture. */
  fixturePath?: string;
}

// ─── The verifier ─────────────────────────────────────────────────────────────

/**
 * Runs every check and RETURNS the exit code; never calls `process.exit`.
 *
 * Returning the code rather than exiting is what lets a test assert the
 * outcome, and it means a future caller could run this as one step of a larger
 * check without the process vanishing underneath it.
 */
export async function main(argv: readonly string[] = [], deps: VerifyDeps = {}): Promise<number> {
  const { live, timeoutOverride } = parseArgs(argv);
  const report = new Report();

  // ── 1. Configuration ──────────────────────────────────────────────────────

  console.log("\n── Configuration ──────────────────────────────────────────────");

  const config = crewSidecarConfigFromEnv(deps.env ?? process.env);
  if (!config) {
    console.log(
      "  FAIL  CREW_SIDECAR_URL / CREW_SIDECAR_API_KEY are not set.\n" +
        "        These are MAC-WORKER-ONLY variables (see .env.example). Without them a\n" +
        "        multi-agent run fails with CREW_SIDECAR_NOT_CONFIGURED and never falls back."
    );
    return 1;
  }

  report.check("CREW_SIDECAR_URL is loopback", isLoopbackUrl(config.url), config.url);
  report.check(
    "CREW_SIDECAR_API_KEY is set",
    config.apiKey.length > 0,
    `${config.apiKey.length} chars`
  );
  report.info(
    `timeout: ${timeoutOverride ?? config.timeoutMs ?? crewSidecarCeilingMs(2)}ms` +
      (timeoutOverride
        ? " (--timeout override)"
        : config.timeoutMs
          ? ""
          : " (compile-time (3+3R)×300s ceiling — set from measured p95)")
  );

  // The client refuses a non-loopback URL at construction, undialled. Proving
  // it here means the guard is live in THIS build, not merely in a unit test.
  try {
    new CrewSidecarClient({ url: "https://crew.example.com", apiKey: "x" }, deps.fetchImpl);
    report.fail("a non-loopback URL is refused", "the client accepted it");
  } catch (err) {
    report.check(
      "a non-loopback URL is refused at construction",
      err instanceof CrewSidecarError && err.code === "not_configured"
    );
  }

  // ── 2. The fixture ────────────────────────────────────────────────────────

  console.log("\n── Fixture ────────────────────────────────────────────────────");

  const fixturePath =
    deps.fixturePath ?? join(process.cwd(), "sidecar", "crewai", "fixtures", "request.json");
  let request: CrewPostRequest;
  try {
    request = JSON.parse(readFileSync(fixturePath, "utf8")) as CrewPostRequest;
  } catch (err) {
    report.fail("the shared fixture is readable", `${fixturePath} — ${describe(err)}`);
    return report.summarize();
  }

  report.check(
    "the fixture pins the validated Qwen tag",
    request.inferenceConfig.model === "qwen3.5:35b-a3b-q4_K_M",
    request.inferenceConfig.model
  );
  report.check(
    "the fixture points Ollama at loopback",
    request.inferenceConfig.baseUrl.startsWith("http://127.0.0.1"),
    request.inferenceConfig.baseUrl
  );
  report.check("the fixture exercises R=2", request.attemptContext.maxQaRounds === 2);

  // ── 3. Reachability ───────────────────────────────────────────────────────

  console.log("\n── Reachability ───────────────────────────────────────────────");

  const doFetch: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const base = config.url.replace(/\/$/, "");

  try {
    const res = await doFetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
    report.check("GET /health responds 200", res.status === 200, `status ${res.status}`);
  } catch (err) {
    report.fail("GET /health", `unreachable — is the sidecar running? (${describe(err)})`);
  }

  // An unauthenticated POST must be refused, and must not leak why.
  try {
    const res = await doFetch(`${base}/crew/post`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-api-key": "wrong-key" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    });
    report.check("a wrong api key is rejected", res.status === 401, `status ${res.status}`);
  } catch (err) {
    report.fail("auth check", describe(err));
  }

  if (!live) {
    console.log(
      "\n── Live run skipped ───────────────────────────────────────────\n" +
        "  Pass --live to run the fixture through Qwen (3 Ollama calls at R=0).\n"
    );
    return report.summarize();
  }

  // ── 4. The live run, through the production client ────────────────────────

  console.log("\n── Live run (real Ollama, real Qwen) ──────────────────────────");

  const client = new CrewSidecarClient(
    { ...config, ...(timeoutOverride ? { timeoutMs: timeoutOverride } : {}) },
    deps.fetchImpl
  );

  const startedAt = Date.now();
  try {
    // Everything below is validated by the client itself before it returns:
    // the strict response schema, `validateCallCounts` (which REFUSES a run
    // whose Editor count is short of 1 + writerRoutes + editorRoutes), and
    // `resolveQaState` (which refuses a mid-loop verdict as non_converged).
    const outcome = await client.generate(request);
    const wallMs = Date.now() - startedAt;

    report.pass("the production client accepted the response", "schema + counters + verdict");
    report.info(
      `qa=${outcome.qaState} revisions=${outcome.qaRevisions} ` +
        `calls=w${outcome.agentCalls.writer}/e${outcome.agentCalls.editor}/q${outcome.agentCalls.qa} ` +
        `sidecarLatency=${outcome.latencyMs}ms wall=${wallMs}ms`
    );

    // Scenario 1: a natural pass is the only routing outcome a real model can
    // be relied on to produce. Scenarios 2-4 are covered deterministically by
    // sidecar/crewai/test_flow_routing.py, which drives the same run_flow.
    report.check(
      "the QA verdict is terminal",
      ["pass", "rejected_unroutable", "unavailable"].includes(outcome.qaState),
      outcome.qaState
    );
    if (outcome.qaState === "pass") {
      report.check(
        "a clean pass reports 1/1/1 and no revisions",
        outcome.qaRevisions === 0 &&
          outcome.agentCalls.writer === 1 &&
          outcome.agentCalls.editor === 1 &&
          outcome.agentCalls.qa === 1,
        `w${outcome.agentCalls.writer}/e${outcome.agentCalls.editor}/q${outcome.agentCalls.qa}`
      );
    }
    if (outcome.qaState === "unavailable") {
      report.note(
        "QA was unavailable — degraded, and correctly NOT a pass. Re-run to\n" +
          "        get a clean scenario-1 observation; investigate if it repeats."
      );
    }

    // The candidate must survive the app's own post parser, not merely be a string.
    try {
      const parsed = parseLlmPost(outcome.raw);
      report.pass(
        "the candidate parses with the production parseLlmPost",
        `${parsed.text.length} chars`
      );
      report.check("the candidate declares a coreMessage", parsed.coreMessage.trim().length > 0);
      const limit = request.generationRequirements.maxTextLength;
      if (limit) {
        report.check(
          "the candidate is within the channel limit",
          parsed.text.length <= limit,
          `${parsed.text.length} / ${limit}`
        );
      }
    } catch (err) {
      report.fail("the candidate parses", describe(err));
    }

    // Model identity — what an A/B comparison must rest on.
    report.check(
      "the reported tag is the tag that was pinned",
      outcome.model.tag === request.inferenceConfig.model,
      `${outcome.model.tag} vs ${request.inferenceConfig.model}`
    );
    if (outcome.model.digest) {
      report.pass("a model digest was reported", `${outcome.model.digest.slice(0, 24)}…`);
    } else {
      report.note(
        "no model digest reported — comparisons will be labelled\n" +
          "        'tag-matched only' rather than 'digest-verified'. Record which\n" +
          "        Ollama API is authoritative for the digest on this build."
      );
    }
    report.info(
      `inferenceFingerprint: ${inferenceFingerprint({
        modelTag: outcome.model.tag,
        modelDigest: outcome.model.digest,
        settings: {
          temperature: request.inferenceConfig.temperature,
          numPredict: request.inferenceConfig.numPredict,
        },
      }).slice(0, 16)}…`
    );

    report.check(
      "degradedStages is consistent with the verdict",
      outcome.qaState !== "unavailable" || outcome.degradedStages.length > 0,
      outcome.degradedStages.join(",") || "none"
    );
  } catch (err) {
    if (err instanceof CrewSidecarError) {
      report.fail(`the live run (${err.code})`, err.message);
      console.log(
        "\n  Failure-code map, for reference:\n" +
          "    timeout          — exceeded CREW_SIDECAR_TIMEOUT_MS\n" +
          "    unavailable      — unreachable, 5xx, 503 crew_busy, or no candidate\n" +
          "    invalid_response — off-contract body, or counters showing a bypassed Editor\n" +
          "    non_converged    — a mid-loop verdict leaked out of the Flow\n" +
          "    qa_parse_error   — the sidecar failed the whole call over an unreadable QA\n" +
          "    not_configured   — no loopback URL for this process"
      );
    } else {
      report.fail("the live run", describe(err));
    }
  }

  // ── 5. Serialization ──────────────────────────────────────────────────────

  console.log("\n── Serialization ──────────────────────────────────────────────");
  report.info("firing two concurrent requests; the second must be refused.");
  const fire = () =>
    doFetch(`${base}/crew/post`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-api-key": config.apiKey },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutOverride ?? crewSidecarCeilingMs(2)),
    }).then((r) => r.status);

  try {
    const [a, b] = await Promise.all([fire(), fire()]);
    report.check(
      "one of two concurrent requests is refused with 503 crew_busy",
      [a, b].includes(503),
      `statuses ${a} and ${b}`
    );
  } catch (err) {
    report.fail("serialization check", describe(err));
  }

  return report.summarize();
}

export function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
    return `${err.name}: ${err.message}${cause}`;
  }
  return String(err);
}

// ─── Entry point ──────────────────────────────────────────────────────────────
//
// Guarded so importing this module in a test runs no checks and prints nothing.
// The same guard `scripts/translate-next-feed-item.ts` uses.
//
// `dotenv/config` is loaded HERE rather than as a top-level import so a test
// that injects `deps.env` is never influenced by the developer's own `.env`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void (async () => {
    await import("dotenv/config");
    try {
      process.exit(await main(process.argv.slice(2)));
    } catch (err) {
      // A throw here is a fault in the verifier itself, not a failed check.
      // Reported distinctly so it is never mistaken for a sidecar problem.
      console.error(`\n  VERIFIER ERROR — ${describe(err)}\n`);
      process.exit(1);
    }
  })();
}
