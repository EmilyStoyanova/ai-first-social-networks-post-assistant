/**
 * One-off cleanup for the RSS link-extraction bug (fixed in
 * lib/integrations/rss/parser.ts).
 *
 * Before the fix, extractLink could latch onto an embedded HTML `<link href="..."/>`
 * inside an item's `<content:encoded>` — e.g. a Mailchimp signup form's stylesheet —
 * and store "//cdn-images.mailchimp.com/embedcode/classic-061523.css" as a feed
 * item's URL. Those rows are not articles; they linger because ingestion only ever
 * upserts. This script removes them.
 *
 * Scope is deliberately narrow and safe:
 *   - Only RSS sources are considered, so the synthetic non-http URLs of
 *     prompt / product_page / calendar_event sources ("prompt:<id>", "event:<id>")
 *     are never touched.
 *   - A row is deleted ONLY when its URL is not a valid absolute http(s) URL
 *     (see isValidArticleUrl). Valid articles — including ones that have merely
 *     dropped out of the current feed — are left untouched. This is NOT automatic
 *     feed pruning; it keys on URL shape alone.
 *
 * Idempotent and safe to re-run. Dry-run by default; pass --apply to delete.
 *
 * Usage:
 *   npx tsx scripts/cleanup-invalid-feed-items.ts            # dry run (default)
 *   npx tsx scripts/cleanup-invalid-feed-items.ts --apply    # actually delete
 */

import "dotenv/config";
import { prisma } from "@/lib/db/client";
import { isValidArticleUrl } from "@/lib/integrations/rss/invalid-feed-url";

async function main() {
  const apply = process.argv.includes("--apply");

  // Narrow at the DB to RSS items whose URL is not plainly absolute http(s); the
  // predicate below is the authoritative check on the returned candidates.
  const candidates = await prisma.feedItem.findMany({
    where: {
      source: { type: "rss" },
      NOT: { OR: [{ url: { startsWith: "http://" } }, { url: { startsWith: "https://" } }] },
    },
    select: { id: true, url: true, title: true, usedInPost: true },
  });

  const invalid = candidates.filter((c) => !isValidArticleUrl(c.url));

  if (invalid.length === 0) {
    console.log("No invalid RSS feed items found. Nothing to clean up.");
    return;
  }

  console.log(`Found ${invalid.length} invalid RSS feed item(s):`);
  for (const it of invalid) {
    console.log(`  - ${it.url}  (usedInPost=${it.usedInPost})  "${it.title ?? ""}"`);
  }

  if (!apply) {
    console.log("\nDry run — no rows deleted. Re-run with --apply to delete them.");
    return;
  }

  const result = await prisma.feedItem.deleteMany({
    where: { id: { in: invalid.map((i) => i.id) } },
  });
  console.log(`\nDeleted ${result.count} invalid RSS feed item(s).`);
}

main()
  .catch((err) => {
    console.error("\nCleanup failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
