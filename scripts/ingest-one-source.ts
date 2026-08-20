/**
 * Ingest exactly ONE RSS source, for real, through the production per-source path.
 *
 * This is the manual "Fetch" action's own service — `ingestContentSource` — called
 * directly instead of through the session-authenticated HTTP route. It bypasses the
 * cron's 6-hour freshness window and CAS lease entirely (by design: that's the whole
 * point of the manual path), but it is otherwise the exact same code the "Fetch"
 * button runs: no lower-level ingestion or DB-write function is touched here.
 *
 * It does NOT enqueue a translation job. `enqueueTranslationAfterIngest` is called by
 * the HTTP route, not by the service — so running this script leaves any new
 * translation-eligible FeedItems for the existing orchestration (the scheduled
 * `/api/v1/internal/cron/translate` run) to pick up normally.
 *
 * Aborts without writing anything if any safety check on the requested source fails.
 *
 * Usage:
 *   npx tsx scripts/ingest-one-source.ts --company <company-slug> --source <source-id>
 *   npm run ingest:one -- --company domestico --source 0eb8f541-5370-470a-b43a-80ce34358fb0
 */

import "dotenv/config";
import { prisma } from "@/lib/db/client";
import { ingestContentSource } from "@/lib/services/company/ingest-content-source.service";

interface Args {
  companySlug: string;
  sourceId: string;
}

function parseArgs(argv: string[]): Args {
  let companySlug: string | undefined;
  let sourceId: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--company" && argv[i + 1]) companySlug = argv[i + 1];
    if (argv[i] === "--source" && argv[i + 1]) sourceId = argv[i + 1];
  }
  if (!companySlug || !sourceId) {
    console.error("Usage: npx tsx scripts/ingest-one-source.ts --company <slug> --source <id>");
    process.exit(1);
  }
  return { companySlug, sourceId };
}

async function resolveActingUser(
  companySlug: string
): Promise<{ userId: string; isGlobalAdmin: boolean } | null> {
  const globalAdmin = await prisma.user.findFirst({
    where: { isGlobalAdmin: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (globalAdmin) return { userId: globalAdmin.id, isGlobalAdmin: true };

  const owner = await prisma.companyMember.findFirst({
    where: { role: "owner", company: { slug: companySlug } },
    select: { userId: true },
    orderBy: { createdAt: "asc" },
  });
  if (owner) return { userId: owner.userId, isGlobalAdmin: false };

  return null;
}

async function main(): Promise<void> {
  const { companySlug, sourceId } = parseArgs(process.argv.slice(2));

  console.log(`Checking source ${sourceId} (expected: ${companySlug} / rss / translate→bg)...`);

  const source = await prisma.contentSource.findFirst({
    where: { id: sourceId, company: { slug: companySlug } },
    select: {
      id: true,
      name: true,
      type: true,
      enabled: true,
      config: true,
      company: { select: { slug: true, name: true } },
    },
  });

  if (!source) {
    console.error(`ABORT: no ContentSource ${sourceId} belonging to company "${companySlug}".`);
    process.exitCode = 1;
    return;
  }

  if (source.type !== "rss") {
    console.error(`ABORT: source type is "${source.type}", expected "rss".`);
    process.exitCode = 1;
    return;
  }

  const config = source.config as { translateEnabled?: boolean; translateToLanguage?: string };
  if (config.translateEnabled !== true) {
    console.error(
      `ABORT: translateEnabled is not true on this source (got ${config.translateEnabled}).`
    );
    process.exitCode = 1;
    return;
  }
  if (config.translateToLanguage !== "bg") {
    console.error(`ABORT: translateToLanguage is not "bg" (got ${config.translateToLanguage}).`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `OK: "${source.name}" — ${source.company.name} (${source.company.slug}), rss, ` +
      `enabled=${source.enabled}, translate→${config.translateToLanguage}`
  );

  const actor = await resolveActingUser(companySlug);
  if (!actor) {
    console.error("ABORT: no global-admin user and no owner of this company were found to act as.");
    process.exitCode = 1;
    return;
  }
  console.log(`Acting as user ${actor.userId} (isGlobalAdmin=${actor.isGlobalAdmin}).`);
  console.log("");

  const result = await ingestContentSource(
    companySlug,
    sourceId,
    actor.userId,
    actor.isGlobalAdmin
  );

  console.log("──────────────────────────────────────────────────────────────────────");
  console.log(`source:       ${source.name} (${sourceId})`);
  if (result.success) {
    console.log(`status:       success`);
    console.log(`itemsCreated: ${result.created}`);
    console.log(`itemsUpdated: ${result.updated}`);
  } else {
    console.log(`status:       failed (${result.code})`);
    if (result.message) console.log(`error:        ${result.message}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
