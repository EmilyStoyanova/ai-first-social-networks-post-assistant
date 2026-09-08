/**
 * The one place a strategy is resolved, for every entry point.
 *
 * `resolve-strategy.ts` is the pure decision; this is the thin service that
 * feeds it — it reads the site settings and answers the two environment
 * questions the resolver cannot ask for itself (is the pinned model usable
 * here, did the caller name a model of their own).
 *
 * ── Why one service and not four call sites ─────────────────────────────────
 *
 * There are four generation entry points (one manual route with an inline and a
 * queued branch, bulk, and cron), and the eligibility rules are the interesting
 * part of the decision: an explicit model choice excludes a run, an unavailable
 * pinned provider excludes a run. Four copies of those rules would drift, and a
 * drifted eligibility rule does not fail loudly — it silently changes who is in
 * the experiment, which is the one kind of bug a measurement cannot survive.
 *
 * ── Never called from inside the generation pipeline ────────────────────────
 *
 * By design this lives at the BOUNDARY. `generatePostFromContext` takes a
 * resolved value and has no way to obtain one, so there is no code path on which
 * a worker could re-resolve and disagree with the payload it was handed.
 */

import {
  resolveGenerationStrategy,
  type ResolvedStrategy,
  type StrategyOverride,
} from "@/lib/ai/strategy/resolve-strategy";
import { pinnedModelAvailable } from "@/lib/ai/strategy/experiment-inference";
import {
  getGenerationStrategySettings,
  type GenerationStrategySettingsDb,
} from "@/lib/services/admin/generation-strategy-settings.service";

export interface ResolveStrategyForRequestInput {
  /** The form's choice, or absent for "use the site default". */
  override?: StrategyOverride | null;
  /**
   * The generation GROUP: a content group id (manual, bulk) or a weekly schedule
   * id (cron). One unit, one arm, so every channel version of a topic agrees.
   */
  stableUnitId?: string | null;
  /** Whether the caller named a specific LlmConfig — which excludes the run. */
  hasExplicitLlmConfig?: boolean;
}

export interface ResolveStrategyForRequestDeps {
  db?: GenerationStrategySettingsDb;
  /** Injected in tests, so eligibility can be exercised without env. */
  pinnedModelAvailable?: () => boolean;
}

/**
 * Resolves one unit's strategy. Never throws — the settings read degrades to the
 * defaults, so a settings outage costs an experiment assignment, not a post.
 */
export async function resolveStrategyForRequest(
  input: ResolveStrategyForRequestInput,
  deps: ResolveStrategyForRequestDeps = {}
): Promise<ResolvedStrategy> {
  const settings = await getGenerationStrategySettings(deps.db);
  const available = (deps.pinnedModelAvailable ?? pinnedModelAvailable)();
  return resolveGenerationStrategy({
    override: input.override,
    stableUnitId: input.stableUnitId,
    settings,
    hasExplicitLlmConfig: input.hasExplicitLlmConfig,
    pinnedModelAvailable: available,
  });
}

/**
 * Resolves SEVERAL units against one settings read — a bulk run's topics.
 *
 * One read rather than N, and one snapshot rather than N: a batch whose fifth
 * topic was assigned under settings an admin changed halfway through the enqueue
 * would be a batch assigned by two different experiments.
 */
export async function resolveStrategiesForUnits(
  unitIds: readonly string[],
  input: Omit<ResolveStrategyForRequestInput, "stableUnitId">,
  deps: ResolveStrategyForRequestDeps = {}
): Promise<ResolvedStrategy[]> {
  const settings = await getGenerationStrategySettings(deps.db);
  const available = (deps.pinnedModelAvailable ?? pinnedModelAvailable)();
  return unitIds.map((stableUnitId) =>
    resolveGenerationStrategy({
      override: input.override,
      stableUnitId,
      settings,
      hasExplicitLlmConfig: input.hasExplicitLlmConfig,
      pinnedModelAvailable: available,
    })
  );
}
