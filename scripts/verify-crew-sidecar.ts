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
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CrewSidecarClient,
  CrewSidecarError,
  crewSidecarCeilingMs,
  crewSidecarConfigFromEnv,
  isLoopbackUrl,
} from "@/lib/ai/crew/crew-sidecar.client";
import type { CrewPostRequest } from "@/lib/ai/crew/crew-contract";
import { parseLlmPost } from "@/lib/ai/parse-llm-post";
import { inferenceFingerprint } from "@/lib/ai/crew/provenance";

const args = process.argv.slice(2);
const live = args.includes("--live");
const timeoutFlag = args.indexOf("--timeout");
const timeoutOverride =
  timeoutFlag !== -1 && args[timeoutFlag + 1] ? Number(args[timeoutFlag + 1]) : undefined;

let failures = 0;

function pass(label: string, detail = ""): void {
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label: string, detail: string): void {
  failures++;
  console.log(`  FAIL  ${label} — ${detail}`);
}

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) pass(label, detail);
  else fail(label, detail || "condition not met");
}

// ─── 1. Configuration ─────────────────────────────────────────────────────────

console.log("\n── Configuration ──────────────────────────────────────────────");

const config = crewSidecarConfigFromEnv();
if (!config) {
  console.log(
    "  FAIL  CREW_SIDECAR_URL / CREW_SIDECAR_API_KEY are not set.\n" +
      "        These are MAC-WORKER-ONLY variables (see .env.example). Without them a\n" +
      "        multi-agent run fails with CREW_SIDECAR_NOT_CONFIGURED and never falls back."
  );
  process.exit(1);
}

check("CREW_SIDECAR_URL is loopback", isLoopbackUrl(config.url), config.url);
check("CREW_SIDECAR_API_KEY is set", config.apiKey.length > 0, `${config.apiKey.length} chars`);
console.log(
  `  INFO  timeout: ${config.timeoutMs ?? crewSidecarCeilingMs(2)}ms` +
    (config.timeoutMs ? "" : " (compile-time (3+3R)×300s ceiling — set from measured p95)")
);

// The client refuses a non-loopback URL at construction, undialled. Proving it
// here means the guard is live in THIS build, not merely in a unit test.
try {
  new CrewSidecarClient({ url: "https://crew.example.com", apiKey: "x" });
  fail("a non-loopback URL is refused", "the client accepted it");
} catch (err) {
  check(
    "a non-loopback URL is refused at construction",
    err instanceof CrewSidecarError && err.code === "not_configured"
  );
}

// ─── 2. The fixture ───────────────────────────────────────────────────────────

console.log("\n── Fixture ────────────────────────────────────────────────────");

const fixturePath = join(process.cwd(), "sidecar", "crewai", "fixtures", "request.json");
const request: CrewPostRequest = JSON.parse(readFileSync(fixturePath, "utf8"));

check(
  "the fixture pins the validated Qwen tag",
  request.inferenceConfig.model === "qwen3.5:35b-a3b-q4_K_M",
  request.inferenceConfig.model
);
check(
  "the fixture points Ollama at loopback",
  request.inferenceConfig.baseUrl.startsWith("http://127.0.0.1"),
  request.inferenceConfig.baseUrl
);
check("the fixture exercises R=2", request.attemptContext.maxQaRounds === 2);

// ─── 3. Health ────────────────────────────────────────────────────────────────

console.log("\n── Reachability ───────────────────────────────────────────────");

const healthUrl = `${config.url.replace(/\/$/, "")}/health`;
try {
  const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
  check("GET /health responds 200", res.status === 200, `status ${res.status}`);
} catch (err) {
  fail("GET /health", `unreachable — is the sidecar running? (${describe(err)})`);
}

// An unauthenticated POST must be refused, and must not leak why.
try {
  const res = await fetch(`${config.url.replace(/\/$/, "")}/crew/post`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-api-key": "wrong-key" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10_000),
  });
  check("a wrong api key is rejected", res.status === 401, `status ${res.status}`);
} catch (err) {
  fail("auth check", describe(err));
}

if (!live) {
  console.log(
    "\n── Live run skipped ───────────────────────────────────────────\n" +
      "  Pass --live to run the fixture through Qwen (3 Ollama calls at R=0).\n"
  );
  summarize();
}

// ─── 4. The live run, through the production client ──────────────────────────

console.log("\n── Live run (real Ollama, real Qwen) ──────────────────────────");

const client = new CrewSidecarClient({
  ...config,
  ...(timeoutOverride ? { timeoutMs: timeoutOverride } : {}),
});

const startedAt = Date.now();
try {
  // Everything below is validated by the client itself before it returns:
  // the strict response schema, `validateCallCounts` (which REFUSES a run whose
  // Editor count is short of 1 + writerRoutes + editorRoutes), and
  // `resolveQaState` (which refuses a mid-loop verdict as non_converged).
  const outcome = await client.generate(request);
  const wallMs = Date.now() - startedAt;

  pass("the production client accepted the response", "schema + counters + verdict");
  console.log(
    `  INFO  qa=${outcome.qaState} revisions=${outcome.qaRevisions} ` +
      `calls=w${outcome.agentCalls.writer}/e${outcome.agentCalls.editor}/q${outcome.agentCalls.qa} ` +
      `sidecarLatency=${outcome.latencyMs}ms wall=${wallMs}ms`
  );

  // Scenario 1: a natural pass is the only routing outcome a real model can be
  // relied on to produce. Scenarios 2-4 are covered deterministically by
  // sidecar/crewai/test_flow_routing.py, which drives the same run_flow.
  check(
    "the QA verdict is terminal",
    ["pass", "rejected_unroutable", "unavailable"].includes(outcome.qaState),
    outcome.qaState
  );
  if (outcome.qaState === "pass") {
    check(
      "a clean pass reports 1/1/1 and no revisions",
      outcome.qaRevisions === 0 &&
        outcome.agentCalls.writer === 1 &&
        outcome.agentCalls.editor === 1 &&
        outcome.agentCalls.qa === 1,
      `w${outcome.agentCalls.writer}/e${outcome.agentCalls.editor}/q${outcome.agentCalls.qa}`
    );
  }
  if (outcome.qaState === "unavailable") {
    console.log(
      "  NOTE  QA was unavailable — degraded, and correctly NOT a pass. Re-run to\n" +
        "        get a clean scenario-1 observation; investigate if it repeats."
    );
  }

  // The candidate must survive the app's own post parser, not merely be a string.
  try {
    const parsed = parseLlmPost(outcome.raw);
    pass("the candidate parses with the production parseLlmPost", `${parsed.text.length} chars`);
    check("the candidate declares a coreMessage", parsed.coreMessage.trim().length > 0);
    const limit = request.generationRequirements.maxTextLength;
    if (limit) {
      check(
        "the candidate is within the channel limit",
        parsed.text.length <= limit,
        `${parsed.text.length} / ${limit}`
      );
    }
  } catch (err) {
    fail("the candidate parses", describe(err));
  }

  // Model identity — what an A/B comparison must rest on.
  check(
    "the reported tag is the tag that was pinned",
    outcome.model.tag === request.inferenceConfig.model,
    `${outcome.model.tag} vs ${request.inferenceConfig.model}`
  );
  if (outcome.model.digest) {
    pass("a model digest was reported", `${outcome.model.digest.slice(0, 24)}…`);
  } else {
    console.log(
      "  NOTE  no model digest reported — comparisons will be labelled\n" +
        "        'tag-matched only' rather than 'digest-verified'. Record which\n" +
        "        Ollama API is authoritative for the digest on this build."
    );
  }
  console.log(
    `  INFO  inferenceFingerprint: ${inferenceFingerprint({
      modelTag: outcome.model.tag,
      modelDigest: outcome.model.digest,
      settings: {
        temperature: request.inferenceConfig.temperature,
        numPredict: request.inferenceConfig.numPredict,
      },
    }).slice(0, 16)}…`
  );

  check(
    "degradedStages is consistent with the verdict",
    outcome.qaState !== "unavailable" || outcome.degradedStages.length > 0,
    outcome.degradedStages.join(",") || "none"
  );
} catch (err) {
  if (err instanceof CrewSidecarError) {
    fail(`the live run (${err.code})`, err.message);
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
    fail("the live run", describe(err));
  }
}

// ─── 5. Serialization ─────────────────────────────────────────────────────────

if (live) {
  console.log("\n── Serialization ──────────────────────────────────────────────");
  console.log("  INFO  firing two concurrent requests; the second must be refused.");
  const fire = () =>
    fetch(`${config.url.replace(/\/$/, "")}/crew/post`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-api-key": config.apiKey },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutOverride ?? crewSidecarCeilingMs(2)),
    }).then((r) => r.status);

  try {
    const [a, b] = await Promise.all([fire(), fire()]);
    check(
      "one of two concurrent requests is refused with 503 crew_busy",
      [a, b].includes(503),
      `statuses ${a} and ${b}`
    );
  } catch (err) {
    fail("serialization check", describe(err));
  }
}

summarize();

function summarize(): never {
  console.log("\n───────────────────────────────────────────────────────────────");
  if (failures === 0) {
    console.log("  ALL CHECKS PASSED\n");
    process.exit(0);
  }
  console.log(`  ${failures} CHECK(S) FAILED\n`);
  process.exit(1);
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
    return `${err.name}: ${err.message}${cause}`;
  }
  return String(err);
}
