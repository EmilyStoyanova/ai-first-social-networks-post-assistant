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
