-- Phase 1.5: semantic-gate calibration diagnostics.
-- Persist the gate outcome for each generated post in its post_semantics row so
-- calibration is queryable (count by decision, similarity distribution, retry
-- and skipped-gate rates) without parsing Post.promptSnapshot JSON. All columns
-- are nullable and additive; existing rows are untouched.

ALTER TABLE "post_semantics"
    ADD COLUMN "gate_top_similarity" DOUBLE PRECISION,
    ADD COLUMN "gate_matched_post_id" TEXT,
    ADD COLUMN "gate_decision" TEXT,
    ADD COLUMN "gate_attempts" INTEGER,
    ADD COLUMN "gate_skipped" BOOLEAN,
    ADD COLUMN "gate_evaluated_at" TIMESTAMP(3);

-- Reporting queries filter to rows that actually carry a gate decision and
-- group/scan by company+channel; a partial index keeps that scan cheap.
CREATE INDEX "post_semantics_gate_decision_idx"
    ON "post_semantics" ("company_id", "channel", "gate_decision")
    WHERE "gate_decision" IS NOT NULL;
