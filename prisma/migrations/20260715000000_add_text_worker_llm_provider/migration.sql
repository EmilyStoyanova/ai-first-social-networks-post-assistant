-- v2-5: Per-Generation LLM Model Selector.
-- Add the `text_worker` value to the LlmProvider enum so admins can register
-- self-hosted TextWorker (Qwen/Ollama) configs via the LLM Providers admin UI.
-- Additive only; existing enum values and rows are untouched.

ALTER TYPE "LlmProvider" ADD VALUE IF NOT EXISTS 'text_worker';
