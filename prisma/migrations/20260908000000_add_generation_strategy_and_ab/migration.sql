-- 2026-09-08 — generation strategy resolution, per-post override, and the
-- single-vs-multi A/B experiment.
--
-- ── What this does NOT do ─────────────────────────────────────────────────
--
-- Nothing is dropped, nothing is renamed, and NOTHING IS BACKFILLED. Every
-- column added to an existing table is nullable (or a scalar list, which
-- Postgres stores as an empty array), so every existing row keeps exactly the
-- meaning it had.
--
-- The absence of a backfill is a decision, not an omission. Every post written
-- before today was written by the single-agent path, and it would be easy to
-- set `generation_strategy = 'single'` for all of them. That would be a lie of
-- a specific and damaging kind: an A/B report counts rows by arm, and a
-- backfilled `single` is indistinguishable from a run that was OBSERVED to be
-- single. NULL means "not recorded", the report excludes it from every
-- denominator, and the experiment measures only runs it actually saw.
--
-- ── Order matters ─────────────────────────────────────────────────────────
--
-- The enum types are created first because three tables reference them.
-- Postgres cannot add an enum-typed column before the type exists.

-- ─── Enums ────────────────────────────────────────────────────────────────

CREATE TYPE "GenerationStrategy" AS ENUM ('single', 'multi');

CREATE TYPE "StrategySource" AS ENUM ('global_default', 'user_override', 'ab_split');

CREATE TYPE "ModelVerification" AS ENUM ('digest_verified', 'tag_matched_only', 'unknown');

-- ─── Site-wide settings (singleton) ───────────────────────────────────────
--
-- One row, id 'global'. The defaults below are exactly today's behaviour:
-- `single` everywhere and no experiment. So creating this table changes
-- nothing until an admin changes something — and an installation that never
-- inserts the row behaves identically, because the service treats an absent
-- row as "unconfigured" rather than as an error.

CREATE TABLE "generation_strategy_settings" (
  "id" TEXT NOT NULL DEFAULT 'global',
  "default_strategy" "GenerationStrategy" NOT NULL DEFAULT 'single',
  "experiment_enabled" BOOLEAN NOT NULL DEFAULT false,
  -- NULL until an experiment is first enabled. An enabled experiment with a
  -- NULL key assigns nothing — the resolver reports it as ineligible rather
  -- than minting a key at generation time, which would give two concurrent
  -- generations two different experiments.
  "experiment_key" TEXT,
  "experiment_allocation_percent" INTEGER NOT NULL DEFAULT 50,
  "updated_by" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "generation_strategy_settings_pkey" PRIMARY KEY ("id")
);

-- SET NULL, not CASCADE: deleting an administrator must never delete the
-- record of the settings they configured.
ALTER TABLE "generation_strategy_settings"
  ADD CONSTRAINT "generation_strategy_settings_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── posts — the product half of the provenance ───────────────────────────
--
-- Four columns, so a post that EXISTS can always say which strategy wrote it
-- and whether that was an experiment assignment or somebody's explicit choice.
-- Duplicated from generation_runs on purpose: runs are written by the tracer,
-- which an operator can switch off, and the product question must not depend
-- on an observability setting.

ALTER TABLE "posts"
  ADD COLUMN "generation_strategy" "GenerationStrategy",
  ADD COLUMN "generation_strategy_source" "StrategySource",
  ADD COLUMN "experiment_key" TEXT,
  ADD COLUMN "experiment_arm" "GenerationStrategy";

-- "Of the posts assigned to this arm, how many were approved / rejected." NULL
-- for every post outside an experiment, so the index covers only those.
CREATE INDEX "posts_experiment_key_experiment_arm_idx"
  ON "posts"("experiment_key", "experiment_arm");

-- ─── generation_runs — the measurement half ───────────────────────────────
--
-- This is the table an A/B report reads, because it holds runs that produced NO
-- POST — the only correct denominator for a failure or unavailability rate.
--
-- `degraded` is nullable rather than DEFAULT false. A default would say of
-- every historical run that it was not degraded, which is a claim none of them
-- made; nullable says "unknown", which is the truth.

ALTER TABLE "generation_runs"
  ADD COLUMN "generation_strategy" "GenerationStrategy",
  ADD COLUMN "generation_strategy_source" "StrategySource",
  ADD COLUMN "experiment_key" TEXT,
  ADD COLUMN "experiment_arm" "GenerationStrategy",
  -- Enough to RECOMPUTE the assignment: hash(key + unit) % 10000 → bucket,
  -- against the allocation as it stood when the assignment was made.
  ADD COLUMN "experiment_unit_id" TEXT,
  ADD COLUMN "experiment_bucket" INTEGER,
  ADD COLUMN "experiment_allocation" INTEGER,
  -- What Ollama ran, as opposed to which application path asked it to. The
  -- existing llm_provider/llm_model columns describe the CALLER and legitimately
  -- differ between the arms, which is exactly why they cannot establish that the
  -- two arms ran the same model.
  ADD COLUMN "inference_fingerprint" TEXT,
  ADD COLUMN "model_tag" TEXT,
  ADD COLUMN "model_digest" TEXT,
  ADD COLUMN "model_verification" "ModelVerification",
  -- The multi-agent inner loop. All NULL on a single-agent run, which has no
  -- critic and no revision cycles.
  ADD COLUMN "qa_state" TEXT,
  ADD COLUMN "qa_revision_rounds" INTEGER,
  ADD COLUMN "agent_calls" INTEGER,
  ADD COLUMN "agent_latency_ms" INTEGER,
  ADD COLUMN "degraded" BOOLEAN,
  ADD COLUMN "degraded_stages" TEXT[];

-- Every run ASSIGNED to an arm, newest first — the report's exposure query.
CREATE INDEX "generation_runs_experiment_key_experiment_arm_started_at_idx"
  ON "generation_runs"("experiment_key", "experiment_arm", "started_at" DESC);
