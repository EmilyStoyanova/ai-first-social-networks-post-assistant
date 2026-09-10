/**
 * The site-wide generation strategy default and the A/B experiment definition.
 *
 * ── Reading is never an error ───────────────────────────────────────────────
 *
 * `getGenerationStrategySettings` returns the defaults when no row exists, and
 * also when the read FAILS. That is unusual for this codebase and deliberate:
 * this function is called on the hot path of every generation, and the
 * alternative to a defaulting read is a generation that fails because a settings
 * table was briefly unreachable. The defaults are exactly today's behaviour —
 * `single`, no experiment — so degrading to them costs an experiment assignment,
 * never a post.
 *
 * ── Why enabling mints a key ────────────────────────────────────────────────
 *
 * `experimentKey` is half the assignment hash, so it is not a label: turning an
 * experiment on without one would leave every unit unassignable, and minting one
 * lazily at generation time would let two concurrent generations invent two
 * different experiments. It is therefore minted HERE, once, at the moment an
 * admin enables an experiment that has never had a key.
 *
 * Re-enabling an experiment that already has a key REUSES it, so pausing and
 * resuming does not re-randomize a running experiment and reshuffle units
 * mid-measurement. Starting a genuinely new experiment is an explicit "reset"
 * (`resetKey`), because that action deliberately discards comparability with
 * everything already collected.
 */

import { prisma } from "@/lib/db/client";
import {
  clampAllocation,
  DEFAULT_STRATEGY_SETTINGS,
  type StrategySettingsSnapshot,
} from "@/lib/ai/strategy/resolve-strategy";
import type { GenerationStrategy } from "@prisma/client";

/** The singleton's primary key. One row, always this id. */
export const STRATEGY_SETTINGS_ID = "global";

export interface GenerationStrategySettingsView extends StrategySettingsSnapshot {
  /** Null until the settings have ever been written. */
  updatedAt: string | null;
}

export interface GenerationStrategySettingsDb {
  generationStrategySettings: {
    findUnique: (args: { where: { id: string } }) => Promise<{
      defaultStrategy: GenerationStrategy;
      experimentEnabled: boolean;
      experimentKey: string | null;
      experimentAllocationPercent: number;
      updatedAt: Date;
    } | null>;
    upsert: (args: {
      where: { id: string };
      create: {
        id: string;
        defaultStrategy: GenerationStrategy;
        experimentEnabled: boolean;
        experimentKey: string | null;
        experimentAllocationPercent: number;
        updatedById: string | null;
      };
      update: {
        defaultStrategy: GenerationStrategy;
        experimentEnabled: boolean;
        experimentKey: string | null;
        experimentAllocationPercent: number;
        updatedById: string | null;
      };
    }) => Promise<{
      defaultStrategy: GenerationStrategy;
      experimentEnabled: boolean;
      experimentKey: string | null;
      experimentAllocationPercent: number;
      updatedAt: Date;
    }>;
  };
}

/**
 * The settings as generation needs them. Never throws.
 *
 * The `catch` degrades to `DEFAULT_STRATEGY_SETTINGS` and says so loudly. A
 * silent degradation here would be genuinely dangerous: an experiment would
 * appear to stop assigning with nothing in the logs to explain the gap in its
 * data.
 */
export async function getGenerationStrategySettings(
  db?: GenerationStrategySettingsDb
): Promise<StrategySettingsSnapshot> {
  // With no injected db AND no database configured there is nowhere for a
  // settings row to live, and the default store would spend a connection
  // timeout discovering that — on every generation, and on every unit test that
  // exercises a generation path without injecting a fake db. Mirrors
  // `tracingEnabled()`'s DATABASE_URL guard for the same reason: a feature that
  // has nothing to read must cost nothing, not a hang. In production the worker
  // and the serverless runtime always have one.
  if (!db && !process.env.DATABASE_URL) return DEFAULT_STRATEGY_SETTINGS;
  const client = db ?? prisma;
  try {
    const row = await client.generationStrategySettings.findUnique({
      where: { id: STRATEGY_SETTINGS_ID },
    });
    if (!row) return DEFAULT_STRATEGY_SETTINGS;
    return {
      defaultStrategy: row.defaultStrategy,
      experimentEnabled: row.experimentEnabled,
      experimentKey: row.experimentKey,
      experimentAllocationPercent: clampAllocation(row.experimentAllocationPercent),
    };
  } catch (err) {
    console.error(
      "[generation-strategy] Could not read the site settings; falling back to " +
        "single-agent with no experiment. A/B assignment is NOT happening:",
      err instanceof Error ? err.message : err
    );
    return DEFAULT_STRATEGY_SETTINGS;
  }
}

export type ReadGenerationStrategySettingsResult =
  | { success: true; settings: GenerationStrategySettingsView }
  | { success: false; code: "FORBIDDEN" };

/** The admin view. Unlike the generation-path read, this one is access-checked. */
export async function readGenerationStrategySettings(
  isGlobalAdmin: boolean,
  db: GenerationStrategySettingsDb = prisma
): Promise<ReadGenerationStrategySettingsResult> {
  if (!isGlobalAdmin) return { success: false, code: "FORBIDDEN" };
  const row = await db.generationStrategySettings.findUnique({
    where: { id: STRATEGY_SETTINGS_ID },
  });
  return {
    success: true,
    settings: row
      ? {
          defaultStrategy: row.defaultStrategy,
          experimentEnabled: row.experimentEnabled,
          experimentKey: row.experimentKey,
          experimentAllocationPercent: clampAllocation(row.experimentAllocationPercent),
          updatedAt: row.updatedAt.toISOString(),
        }
      : { ...DEFAULT_STRATEGY_SETTINGS, updatedAt: null },
  };
}

export interface UpdateGenerationStrategySettingsInput {
  defaultStrategy?: GenerationStrategy;
  experimentEnabled?: boolean;
  experimentAllocationPercent?: number;
  /**
   * Start a NEW experiment: mint a fresh key, discarding comparability with
   * everything already assigned. Explicit because that is a destructive act for
   * a measurement, not a settings tweak.
   */
  resetKey?: boolean;
}

export type UpdateGenerationStrategySettingsResult =
  | { success: true; settings: GenerationStrategySettingsView }
  | { success: false; code: "FORBIDDEN" | "INVALID_ALLOCATION" };

export interface UpdateGenerationStrategySettingsDeps {
  db?: GenerationStrategySettingsDb;
  /** Injected in tests so a minted key is deterministic. */
  newExperimentKey?: () => string;
}

export async function updateGenerationStrategySettings(
  isGlobalAdmin: boolean,
  userId: string | null,
  input: UpdateGenerationStrategySettingsInput,
  deps: UpdateGenerationStrategySettingsDeps = {}
): Promise<UpdateGenerationStrategySettingsResult> {
  if (!isGlobalAdmin) return { success: false, code: "FORBIDDEN" };

  const db = deps.db ?? prisma;
  const newExperimentKey = deps.newExperimentKey ?? (() => `exp-${crypto.randomUUID()}`);

  // Refused rather than clamped. The generation-path resolver clamps, because
  // there its job is to keep a bad number from breaking a post; here an admin is
  // typing a value and must be told it is not one.
  if (input.experimentAllocationPercent !== undefined) {
    const pct = input.experimentAllocationPercent;
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
      return { success: false, code: "INVALID_ALLOCATION" };
    }
  }

  const existing = await db.generationStrategySettings.findUnique({
    where: { id: STRATEGY_SETTINGS_ID },
  });
  const current: StrategySettingsSnapshot = existing
    ? {
        defaultStrategy: existing.defaultStrategy,
        experimentEnabled: existing.experimentEnabled,
        experimentKey: existing.experimentKey,
        experimentAllocationPercent: clampAllocation(existing.experimentAllocationPercent),
      }
    : DEFAULT_STRATEGY_SETTINGS;

  const experimentEnabled = input.experimentEnabled ?? current.experimentEnabled;

  // A key is minted on the first enable and REUSED on every later one — see the
  // module docblock. Disabling deliberately keeps the key, so pausing an
  // experiment and resuming it continues the same one.
  let experimentKey = current.experimentKey;
  if (input.resetKey) experimentKey = newExperimentKey();
  else if (experimentEnabled && experimentKey === null) experimentKey = newExperimentKey();

  const next = {
    defaultStrategy: input.defaultStrategy ?? current.defaultStrategy,
    experimentEnabled,
    experimentKey,
    experimentAllocationPercent:
      input.experimentAllocationPercent ?? current.experimentAllocationPercent,
    updatedById: userId,
  };

  const row = await db.generationStrategySettings.upsert({
    where: { id: STRATEGY_SETTINGS_ID },
    create: { id: STRATEGY_SETTINGS_ID, ...next },
    update: next,
  });

  return {
    success: true,
    settings: {
      defaultStrategy: row.defaultStrategy,
      experimentEnabled: row.experimentEnabled,
      experimentKey: row.experimentKey,
      experimentAllocationPercent: clampAllocation(row.experimentAllocationPercent),
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}
