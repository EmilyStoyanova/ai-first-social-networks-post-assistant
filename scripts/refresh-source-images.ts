/**
 * One-off refresh of `FeedItem.sourceImageUrl` for RSS articles behind DRAFT
 * posts, using the CURRENT article-image extraction.
 *
 * Why it exists: the stored image was resolved once, at ingestion, by whatever
 * version of the extractor was running that day. Items ingested before the
 * extractor learned to skip site banners, ad slots, promo blocks and
 * related-content rails still point at that older pick, and nothing about the
 * row reveals it — the value has to be recomputed to find out. So the stored
 * value is deliberately not trusted here.
 *
 * What it will and will not do:
 *   - Reads only RSS feed items that back a post still in `draft`. Posts already
 *     reviewed keep the image they were reviewed with.
 *   - Writes exactly one column: FeedItem.sourceImageUrl. The post, its
 *     mediaAssetId and every MediaAsset are untouched — this only changes what
 *     the "Source article" tab OFFERS. Swapping the attached image stays a
 *     deliberate click.
 *   - Never clears a stored value. If the refetch finds nothing (offline,
 *     paywall, removed image), the existing value stands.
 *   - Fetches each article once and never fails the run over one article.
 *
 * Safe to re-run; a second pass over unchanged articles writes nothing.
 * Explicitly manual — no cron entry, nothing schedules this.
 *
 * Usage:
 *   npx tsx scripts/refresh-source-images.ts               # dry run (default)
 *   npx tsx scripts/refresh-source-images.ts --apply       # actually write
 *   npx tsx scripts/refresh-source-images.ts --limit=10    # first 10 articles only
 *
 * Requires DATABASE_URL and outbound network access to the publishers.
 */

import "dotenv/config";
import { prisma } from "@/lib/db/client";
import { refreshSourceImages } from "@/lib/services/posts/refresh-source-images.service";

function parseLimit(argv: string[]): number | undefined {
  const arg = argv.find((a) => a.startsWith("--limit="));
  if (!arg) return undefined;
  const value = Number(arg.slice("--limit=".length));
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`Invalid --limit: expected a positive integer, got "${arg}".`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const limit = parseLimit(process.argv);

  console.log(
    apply
      ? "Refreshing source article images for draft RSS posts…\n"
      : "DRY RUN — no rows will be written. Re-run with --apply to save.\n"
  );

  const summary = await refreshSourceImages({
    dryRun: !apply,
    limit,
    onResult: ({ candidate, outcome }) => {
      switch (outcome.kind) {
        case "updated":
          console.log(`  ${apply ? "updated" : "would update"}  ${candidate.url}`);
          console.log(`      from: ${outcome.previous ?? "(none)"}`);
          console.log(`        to: ${outcome.imageUrl}`);
          break;
        case "unchanged":
          console.log(`  unchanged   ${candidate.url}`);
          break;
        case "no_image":
          console.log(`  no image    ${candidate.url}  (stored value kept)`);
          break;
        case "failed":
          console.log(`  FAILED      ${candidate.url}  — ${outcome.error}`);
          break;
      }
    },
  });

  console.log(
    `\nDone. scanned=${summary.scanned} ${apply ? "updated" : "would update"}=${summary.updated} ` +
      `unchanged=${summary.unchanged} noImage=${summary.noImage} failed=${summary.failed}`
  );

  if (!apply && summary.updated > 0) {
    console.log("\nRe-run with --apply to write these changes.");
  }
}

main()
  .catch((err) => {
    console.error("\nRefresh failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
