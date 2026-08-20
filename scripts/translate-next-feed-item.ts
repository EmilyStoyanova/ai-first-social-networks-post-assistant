/**
 * Seeing — and optionally running — the NEXT article translation, exactly one.
 *
 * The cron path cannot do this: `/api/v1/internal/cron/translate` enqueues a job whose
 * handler translates a BATCH (TRANSLATION_BATCH_SIZE = 10) for every company. For the
 * first real run on a new engine that is nine articles too many, so this script exists
 * to make "one article, through the real pipeline" possible.
 *
 * Usage:
 *   npm run translate:next                    # READ-ONLY. Lists what is eligible.
 *   npm run translate:next -- --limit 20      # look further down the queue
 *   npm run translate:next -- --translate-one # translates EXACTLY ONE item, for real
 *
 * The default is read-only on purpose: running this by accident must never write.
 *
 * `--translate-one` is not a bypass. It calls the same `translateFeedItems` service the
 * worker calls, with `limit: 1`, so the atomic claim, the attempt counter, the backoff,
 * the quality gate, the trace run and the DB write are all the production ones. The only
 * difference is that it stops after one item.
 */

import "dotenv/config";
import { prisma } from "@/lib/db/client";
import { translationSelectableWhere } from "@/lib/ai/feed-item-translation-claim";
import { resolveTranslationConfig } from "@/lib/ai/feed-item-translation";
import { translateFeedItems } from "@/lib/services/cron/translate-feed-items.service";

interface Args {
  limit: number;
  translateOne: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 10, translateOne: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--limit" && argv[i + 1]) args.limit = Number(argv[i + 1]);
    if (argv[i] === "--translate-one") args.translateOne = true;
  }
  return args;
}

/** The same ordering the cron uses, so the head of this list is what it would pick. */
async function eligible(limit: number) {
  return prisma.feedItem.findMany({
    where: { source: { enabled: true }, ...translationSelectableWhere(new Date()) },
    orderBy: [{ translationNextRetryAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: limit,
    select: {
      id: true,
      companyId: true,
      title: true,
      url: true,
      createdAt: true,
      translationStatus: true,
      translationAttemptCount: true,
      translationNextRetryAt: true,
      translationProvider: true,
      translationModel: true,
      // The company hangs off the SOURCE — FeedItem carries only the `companyId` scalar.
      source: {
        select: {
          type: true,
          config: true,
          company: { select: { name: true, slug: true, defaultLang: true } },
        },
      },
    },
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rows = await eligible(args.limit);

  if (rows.length === 0) {
    console.log("Nothing is eligible for translation right now.");
    console.log("");
    console.log("An item is eligible when its source is enabled, its attempt count is under");
    console.log("the maximum, and it is pending/failed with no future retry time (or its");
    console.log("`translating` lease has expired). Ingest a feed to create new ones.");
    return;
  }

  console.log(`${rows.length} item(s) eligible, in the order the cron would take them:`);
  console.log("");
  rows.forEach((row, index) => {
    const cfg = resolveTranslationConfig(
      row.source.type,
      row.source.config,
      row.source.company.defaultLang ?? "en"
    );
    console.log(`${index === 0 ? "→" : " "} ${index + 1}. ${row.id}`);
    console.log(`     company     ${row.source.company.name} (${row.source.company.slug})`);
    console.log(`     title       ${row.title ?? "(untitled)"}`);
    console.log(`     url         ${row.url}`);
    console.log(`     ingested    ${row.createdAt.toISOString()}`);
    console.log(
      `     status      ${row.translationStatus ?? "(null)"} · attempts ${row.translationAttemptCount}` +
        (row.translationNextRetryAt
          ? ` · retry after ${row.translationNextRetryAt.toISOString()}`
          : "")
    );
    console.log(
      `     last engine ${row.translationProvider ?? "(none)"} / ${row.translationModel ?? "(none)"}`
    );
    console.log(
      `     translate?  ${cfg.enabled ? `yes → ${cfg.targetLanguage}` : "NO (disabled on the source)"}`
    );
    console.log("");
  });

  if (!args.translateOne) {
    console.log("Read-only. Nothing was claimed, translated or written.");
    console.log("Add --translate-one to translate the item marked → above.");
    return;
  }

  const target = rows[0];
  console.log("──────────────────────────────────────────────────────────────────────");
  console.log(`Translating EXACTLY ONE item: ${target.id}`);
  console.log(`Company: ${target.source.company.name} (${target.source.company.slug})`);
  console.log("");

  const summary = await translateFeedItems({ companyId: target.companyId, limit: 1 });

  console.log("");
  console.log("Summary:", summary);
  console.log("");
  console.log("Inspect the stored result and its trace:");
  console.log(`  npm run db:studio     → feed_items → ${target.id}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
