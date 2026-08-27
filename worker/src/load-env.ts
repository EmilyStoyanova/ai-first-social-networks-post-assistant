/**
 * Environment preload — has NO imports that reach the Prisma client, and MUST be
 * imported before any module that does (see index.ts's first import).
 *
 * Loading the repo-root .env as an import side effect guarantees DATABASE_URL is
 * populated before the shared client (`@/lib/db/client`) is constructed. ES module
 * imports evaluate in source order, so importing this first runs it ahead of the
 * handler imports whose static chain reaches the Prisma client. Without this, the
 * client would be built with an empty connection string when the worker relies on
 * the .env file (local dev) rather than real process env vars (production).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

// Repo root regardless of the current working directory: worker/src → ../..
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
loadEnv({ path: path.join(repoRoot, ".env") });

/**
 * Marks this process as the worker, which is how `lib/queue/wake-notifier.ts`
 * knows not to send it a wake signal.
 *
 * It matters because the worker shares that .env, and the .env that configures
 * the Next app's `WORKER_WAKE_URL` is the same file this just loaded. Without
 * this line, every follow-up a handler enqueues — ingestion → translation →
 * classification, extraction — would have the worker POST a wake request to its
 * own public tunnel URL and back to itself: a round trip over the internet to
 * tell a process that is demonstrably awake to wake up, spending its own
 * rate-limit budget to do so.
 *
 * Set here rather than in `config.ts` because the notifier reads `process.env`
 * at call time and this module is guaranteed to run first (see index.ts's first
 * import). Assigned unconditionally — nothing else in the system sets it, and a
 * worker is a worker whatever the environment claims.
 */
process.env.WORKER_PROCESS = "1";
