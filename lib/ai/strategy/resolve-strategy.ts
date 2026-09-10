/**
 * Which orchestration writes a post, decided ONCE, before anything runs.
 *
 * ── Why this is a pure function with no I/O ─────────────────────────────────
 *
 * The decision has to survive a queue. A generation is enqueued in a serverless
 * function and executed minutes later in the Mac worker, possibly twice (a
 * duplicate delivery), possibly after a retry, and possibly across a deploy. If
 * the worker re-asked "which strategy?" it could get a different answer than the
 * one the post was assigned — an admin toggled the experiment, or the allocation
 * moved — and an A/B arm that changes between assignment and execution is not an
 * arm at all.
 *
 * So this module takes a SNAPSHOT of everything the decision depends on and
 * returns a value. The value is serialized into the job payload
 * (`resolvedStrategySchema`), carried to the execution point, and obeyed. There
 * is deliberately no function here that reads the database, so there is no way
 * to accidentally resolve a second time deep in the pipeline.
 *
 * ── The precedence, and why it is this order ────────────────────────────────
 *
 *   1. an explicit per-post/user override      — a person asked for this
 *   2. a deterministic A/B assignment          — if eligible and enabled
 *   3. the site-wide default                   — everything else
 *
 * An explicit choice wins outright, and the resulting run is marked
 * `user_override` so it can be EXCLUDED from the experiment's denominators. That
 * exclusion is the point of the ordering: somebody who picks `multi` for a post
 * probably picked it for a reason connected to that post, and counting their
 * choice as a randomized assignment would import that reason into the
 * measurement as if chance had put it there.
 *
 * ── Determinism, and the absence of Math.random ─────────────────────────────
 *
 * Assignment is `sha256(experimentKey + ":" + unitId)` folded into a bucket. It
 * is a hash and not a draw, which buys three properties at once:
 *
 *   • a retry recomputes the same arm, so the payload and the recomputation can
 *     never disagree;
 *   • every channel version of one topic lands in the same arm, because they
 *     share the unit;
 *   • a NEW experiment key re-randomizes every unit, so a second experiment does
 *     not inherit the first one's split and correlate with it.
 *
 * The unit is the generation GROUP, never `Post.id` — the post does not exist
 * when the decision is made, and a post id would put a topic's Facebook version
 * in one arm and its LinkedIn version in the other.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { GenerationStrategy, StrategySource } from "@/lib/ai/crew/provenance";

export type { GenerationStrategy, StrategySource };

/**
 * The bucket space. 10 000 rather than 100 so an allocation can later be
 * expressed to two decimal places without redefining what a stored
 * `experimentBucket` means — an old bucket must stay comparable against a new
 * allocation.
 */
export const BUCKET_SPACE = 10_000;

/** What a person can ask for in the generation form. */
export const STRATEGY_OVERRIDES = ["site_default", "single", "multi"] as const;
export type StrategyOverride = (typeof STRATEGY_OVERRIDES)[number];

/**
 * Why an eligible-looking run was NOT entered into the experiment.
 *
 * Recorded rather than implied. "This post is single because the default is
 * single" and "this post is single because the experiment could not accept it"
 * are different facts, and only the second is a reason to look at the
 * configuration.
 */
export type AbIneligibleReason =
  | "experiment_disabled"
  | "no_experiment_key"
  | "no_stable_unit"
  | "explicit_model_choice"
  | "pinned_model_unavailable";

/**
 * The decision, and enough of its inputs to reproduce it.
 *
 * `experimentBucket` and `experimentUnitId` are not decoration: with the key and
 * the allocation beside them, any later reader can recompute the hash and
 * confirm the arm — which is what makes "why was this post in the multi arm?" an
 * answerable question months afterwards rather than a matter of trust.
 */
export interface ResolvedStrategy {
  strategy: GenerationStrategy;
  source: StrategySource;
  /** The experiment that assigned this run. Null unless `source` is `ab_split`. */
  experimentKey: string | null;
  /**
   * The arm assigned, which is what `strategy` executes.
   *
   * Stored separately so the two can disagree audibly downstream: a run
   * ASSIGNED `multi` whose sidecar was unreachable is a failed multi run, and it
   * must never be counted as an assignment to `single`.
   */
  experimentArm: GenerationStrategy | null;
  experimentUnitId: string | null;
  experimentBucket: number | null;
  /** Percent allocated to the multi arm at the moment of assignment. */
  experimentAllocation: number | null;
  /** Set only when the experiment was live but this run could not enter it. */
  abIneligibleReason: AbIneligibleReason | null;
}

/**
 * The wire form, for a queue payload.
 *
 * `.strict()` for the reason every other payload schema in `lib/queue/` is: this
 * crosses a process boundary, and a worker reading a field it does not
 * understand — or silently dropping one it should have obeyed — would execute a
 * strategy nobody chose. A loud schema error is the better failure.
 */
export const resolvedStrategySchema = z
  .object({
    strategy: z.enum(["single", "multi"]),
    source: z.enum(["global_default", "user_override", "ab_split"]),
    experimentKey: z.string().min(1).nullable(),
    experimentArm: z.enum(["single", "multi"]).nullable(),
    experimentUnitId: z.string().min(1).nullable(),
    experimentBucket: z
      .number()
      .int()
      .min(0)
      .max(BUCKET_SPACE - 1)
      .nullable(),
    experimentAllocation: z.number().int().min(0).max(100).nullable(),
    abIneligibleReason: z
      .enum([
        "experiment_disabled",
        "no_experiment_key",
        "no_stable_unit",
        "explicit_model_choice",
        "pinned_model_unavailable",
      ])
      .nullable(),
  })
  .strict();

/**
 * What a caller that resolved nothing behaves as.
 *
 * Exists so no code path has to invent a strategy from `undefined`. Every field
 * is the pre-existing behaviour: the single-agent loop, chosen by the site
 * default, in no experiment. A caller that forgets to resolve therefore gets
 * TODAY'S behaviour rather than an accidental multi-agent run.
 */
export const SINGLE_BY_DEFAULT: ResolvedStrategy = {
  strategy: "single",
  source: "global_default",
  experimentKey: null,
  experimentArm: null,
  experimentUnitId: null,
  experimentBucket: null,
  experimentAllocation: null,
  abIneligibleReason: null,
};

/** The site settings, as the resolver needs them. */
export interface StrategySettingsSnapshot {
  defaultStrategy: GenerationStrategy;
  experimentEnabled: boolean;
  experimentKey: string | null;
  /** Percent to the MULTI arm, 0–100. */
  experimentAllocationPercent: number;
}

/** Settings for an installation where nothing has been configured. */
export const DEFAULT_STRATEGY_SETTINGS: StrategySettingsSnapshot = {
  defaultStrategy: "single",
  experimentEnabled: false,
  experimentKey: null,
  experimentAllocationPercent: 50,
};

export interface ResolveStrategyInput {
  /**
   * The form's choice. `site_default` and `undefined` are the same thing — no
   * override — and both fall through to the experiment and then the default.
   */
  override?: StrategyOverride | null;
  /**
   * The generation GROUP this run belongs to: a content group id for manual and
   * bulk work, a weekly schedule id for cron. Null when the caller genuinely has
   * no stable identifier, which makes the run ineligible rather than randomly
   * assigned.
   */
  stableUnitId?: string | null;
  settings: StrategySettingsSnapshot;
  /**
   * Whether the caller named a specific LLM config.
   *
   * An explicit model choice makes a run ineligible for the experiment. Both
   * arms must run the same model, so entering this run would mean either
   * overriding the user's choice or comparing across models — and the second is
   * how an orchestration experiment quietly becomes a model experiment.
   */
  hasExplicitLlmConfig?: boolean;
  /**
   * Whether the model both arms would be pinned to is actually usable in this
   * environment. False makes the run ineligible: an experiment that cannot pin
   * its control arm cannot hold the model constant.
   */
  pinnedModelAvailable?: boolean;
}

export function resolveGenerationStrategy(input: ResolveStrategyInput): ResolvedStrategy {
  const { settings } = input;

  // ── 1. An explicit choice wins, and is never an experiment assignment ────
  if (input.override === "single" || input.override === "multi") {
    return {
      ...SINGLE_BY_DEFAULT,
      strategy: input.override,
      source: "user_override",
    };
  }

  // ── 2. The deterministic A/B assignment, if this run may take part ───────
  const ineligible = abIneligibility(input);
  if (ineligible === null) {
    // Both non-null by the eligibility check above; asserted through locals so
    // the arithmetic below reads without optional chaining.
    const key = settings.experimentKey as string;
    const unitId = input.stableUnitId as string;
    const allocation = clampAllocation(settings.experimentAllocationPercent);
    const bucket = assignmentBucket(key, unitId);
    // `<` and not `<=`: with allocation 0 no bucket qualifies, and with
    // allocation 100 every bucket does. `<=` would leak one unit into the multi
    // arm at an allocation of 0, which is the one value an operator uses to
    // mean "stop assigning".
    const arm: GenerationStrategy = bucket < allocation * (BUCKET_SPACE / 100) ? "multi" : "single";
    return {
      strategy: arm,
      source: "ab_split",
      experimentKey: key,
      experimentArm: arm,
      experimentUnitId: unitId,
      experimentBucket: bucket,
      experimentAllocation: allocation,
      abIneligibleReason: null,
    };
  }

  // ── 3. The site-wide default ─────────────────────────────────────────────
  return {
    ...SINGLE_BY_DEFAULT,
    strategy: settings.defaultStrategy,
    source: "global_default",
    // Only reported when an experiment was actually running: with no experiment
    // configured there is nothing to be ineligible FOR, and reporting a reason
    // would make every ordinary generation look like a refused one.
    abIneligibleReason: ineligible === "experiment_disabled" ? null : ineligible,
  };
}

/** Null when the run may be assigned; otherwise why it may not. */
function abIneligibility(input: ResolveStrategyInput): AbIneligibleReason | null {
  if (!input.settings.experimentEnabled) return "experiment_disabled";
  if (!input.settings.experimentKey) return "no_experiment_key";
  if (!input.stableUnitId) return "no_stable_unit";
  if (input.hasExplicitLlmConfig) return "explicit_model_choice";
  if (input.pinnedModelAvailable === false) return "pinned_model_unavailable";
  return null;
}

/**
 * `hash(experimentKey + ":" + unitId)` folded into `[0, BUCKET_SPACE)`.
 *
 * SHA-256 rather than a cheap string hash: the property being bought is that the
 * bucket is uncorrelated with anything else about the unit. A weak hash over
 * UUIDs that share a prefix (or over sequential schedule ids) can leave visible
 * structure, and structure in the assignment is confounding — the arms would
 * differ systematically in whatever the structure tracked.
 *
 * The separator is not cosmetic. Without it, key `"exp1"` + unit `"23"` and key
 * `"exp12"` + unit `"3"` would hash identically, so renaming an experiment could
 * silently reproduce the previous split for some units. A colon cannot appear in
 * a UUID, and the key is minted by the service.
 */
export function assignmentBucket(experimentKey: string, unitId: string): number {
  const digest = createHash("sha256").update(`${experimentKey}:${unitId}`).digest();
  // The first four bytes, read big-endian as an unsigned 32-bit integer. Taken
  // from the digest's own bytes rather than by parsing hex, so there is no
  // string step to get the endianness wrong in.
  const value = digest.readUInt32BE(0);
  return value % BUCKET_SPACE;
}

/**
 * An out-of-range allocation is clamped, not rejected.
 *
 * This runs at generation time, where the alternative to clamping is failing a
 * generation over a settings value. The service that WRITES the setting
 * validates it properly; this is the second line, and its job is to keep a bad
 * number from becoming a broken post.
 */
export function clampAllocation(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
}
