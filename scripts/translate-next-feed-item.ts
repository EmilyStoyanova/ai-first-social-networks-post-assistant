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
 *
 * ── Retrying ONE specific item by id ─────────────────────────────────────────────
 * `--limit`/head-of-queue selection cannot target a specific item — a burst of older
 * items ahead of it in the queue would be translated first. `--id` selects the queue's
 * ORDERING mechanism itself back out: it reads the one item, verifies it against the
 * exact same eligibility predicate the batch path uses (`translationSelectableWhere` —
 * imported, not reimplemented), and — only then, only with `--translate-one` — hands
 * `translateFeedItems` a `findCandidates` override that returns just that one row. The
 * override changes nothing about HOW the item is translated: the atomic claim, the
 * quality gate, the trace and the DB write are the same `translateFeedItem` call the
 * batch path makes; only WHICH row is offered to it differs. Eligibility is never
 * forced — a row that fails the check is never handed to `translateFeedItems` at all,
 * and the real atomic claim inside it still applies its own WHERE at call time, so even
 * a state change between this script's read and the claim is handled the normal way
 * (the claim is simply lost, not overridden).
 *
 *   npm run translate:next -- --id <feed-item-id>                  # READ-ONLY check
 *   npm run translate:next -- --id <feed-item-id> --translate-one  # translate it, for real
 */

import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "@/lib/db/client";
import { translationSelectableWhere } from "@/lib/ai/feed-item-translation-claim";
import {
  resolveTranslationConfig,
  isBulgarianTarget,
  MAX_TRANSLATION_ATTEMPTS,
} from "@/lib/ai/feed-item-translation";
import { translateFeedItems } from "@/lib/services/cron/translate-feed-items.service";

export interface Args {
  limit: number;
  translateOne: boolean;
  id: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 10, translateOne: false, id: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--limit" && argv[i + 1]) args.limit = Number(argv[i + 1]);
    if (argv[i] === "--translate-one") args.translateOne = true;
    if (argv[i] === "--id" && argv[i + 1]) args.id = argv[i + 1];
  }
  return args;
}

/** Full state of one FeedItem, for the `--id` path — display fields plus what eligibility needs. */
export interface FeedItemForRetry {
  id: string;
  companyId: string;
  title: string | null;
  content: string | null;
  url: string;
  createdAt: Date;
  translationStatus: string | null;
  translationHash: string | null;
  translationAttemptCount: number;
  translationNextRetryAt: Date | null;
  translationLeaseExpiresAt: Date | null;
  translationProvider: string | null;
  translationModel: string | null;
  source: {
    type: string;
    config: unknown;
    enabled: boolean;
    company: { name: string; slug: string; defaultLang: string | null };
  };
}

async function defaultLoadById(id: string): Promise<FeedItemForRetry | null> {
  return prisma.feedItem.findUnique({
    where: { id },
    select: {
      id: true,
      companyId: true,
      title: true,
      content: true,
      url: true,
      createdAt: true,
      translationStatus: true,
      translationHash: true,
      translationAttemptCount: true,
      translationNextRetryAt: true,
      translationLeaseExpiresAt: true,
      translationProvider: true,
      translationModel: true,
      source: {
        select: {
          type: true,
          config: true,
          enabled: true,
          company: { select: { name: true, slug: true, defaultLang: true } },
        },
      },
    },
  });
}

/** The exact predicate the cron/batch path selects with — reused, not reimplemented. */
async function defaultIsSelectable(id: string, now: Date): Promise<boolean> {
  const row = await prisma.feedItem.findFirst({
    where: { id, ...translationSelectableWhere(now) },
    select: { id: true },
  });
  return row !== null;
}

/** Injectable seams for `runById`, so the eligibility decision unit-tests without a database. */
export interface RunByIdDeps {
  loadItem?: (id: string) => Promise<FeedItemForRetry | null>;
  isSelectable?: (id: string, now: Date) => Promise<boolean>;
  translate?: typeof translateFeedItems;
  now?: () => Date;
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
}

/** Prints the same status line the list view uses, for one item's current state. */
function printState(item: FeedItemForRetry, log: (msg: string) => void): void {
  log(`FeedItem ${item.id}`);
  log(`  company     ${item.source.company.name} (${item.source.company.slug})`);
  log(`  title       ${item.title ?? "(untitled)"}`);
  log(`  url         ${item.url}`);
  log(`  ingested    ${item.createdAt.toISOString()}`);
  log(
    `  status      ${item.translationStatus ?? "(null)"} · attempts ${item.translationAttemptCount}/${MAX_TRANSLATION_ATTEMPTS}` +
      (item.translationNextRetryAt
        ? ` · retry after ${item.translationNextRetryAt.toISOString()}`
        : "")
  );
  log(
    `  last engine ${item.translationProvider ?? "(none)"} / ${item.translationModel ?? "(none)"}`
  );
  log("");
}

/**
 * Runs the `--id` flow: read, print state, verify eligibility against the real
 * production rules, then (only with `--translate-one`) hand that one row to
 * `translateFeedItems`. Returns without translating on any ineligibility.
 *
 * Every DB read and the translation call itself are injectable seams (`deps`), each
 * defaulting to the real implementation — the same shape `translateFeedItems` itself
 * uses — so the eligibility decision unit-tests without a database, while production
 * runs go through the real Prisma client and the real translation service untouched.
 */
export async function runById(
  id: string,
  translateOne: boolean,
  deps: RunByIdDeps = {}
): Promise<void> {
  const loadItem = deps.loadItem ?? defaultLoadById;
  const isSelectable = deps.isSelectable ?? defaultIsSelectable;
  const translate = deps.translate ?? translateFeedItems;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const errorLog = deps.errorLog ?? ((msg: string) => console.error(msg));

  const item = await loadItem(id);
  if (!item) {
    errorLog(`No FeedItem found with id ${id}.`);
    process.exitCode = 1;
    return;
  }

  printState(item, log);

  if (!item.source.enabled) {
    errorLog("NOT ELIGIBLE: this item's content source is disabled.");
    process.exitCode = 1;
    return;
  }

  const cfg = resolveTranslationConfig(
    item.source.type,
    item.source.config,
    item.source.company.defaultLang ?? "en"
  );
  if (!cfg.enabled) {
    errorLog("NOT ELIGIBLE: translation is disabled (translateEnabled is off on this source).");
    process.exitCode = 1;
    return;
  }
  if (!isBulgarianTarget(cfg.targetLanguage)) {
    errorLog(`NOT ELIGIBLE: target language is "${cfg.targetLanguage}", not Bulgarian.`);
    process.exitCode = 1;
    return;
  }
  if (item.translationAttemptCount >= MAX_TRANSLATION_ATTEMPTS) {
    errorLog(
      `NOT ELIGIBLE: attempt count exhausted (${item.translationAttemptCount}/${MAX_TRANSLATION_ATTEMPTS}).`
    );
    process.exitCode = 1;
    return;
  }

  // The exact predicate the cron/batch path selects with — reused, not reimplemented.
  // (A `completed` item whose input hash has since changed is a separate re-claim path
  // inside `claimFeedItemForTranslation` that this predicate does not cover; irrelevant
  // to a `failed` item and out of scope for retrying one specific known-failed item.)
  const nowValue = now();
  const selectable = await isSelectable(id, nowValue);
  if (!selectable) {
    if (
      (item.translationStatus === "pending" || item.translationStatus === "failed") &&
      item.translationNextRetryAt &&
      item.translationNextRetryAt > nowValue
    ) {
      errorLog(
        `NOT ELIGIBLE YET: retry is not due until ${item.translationNextRetryAt.toISOString()}.`
      );
    } else if (item.translationStatus === "translating" && item.translationLeaseExpiresAt) {
      errorLog(
        `NOT ELIGIBLE: currently claimed by another run, lease expires ${item.translationLeaseExpiresAt.toISOString()}.`
      );
    } else {
      errorLog(`NOT ELIGIBLE: status "${item.translationStatus}" is not translatable right now.`);
    }
    process.exitCode = 1;
    return;
  }

  log("ELIGIBLE for translation right now.");
  log("");

  if (!translateOne) {
    log("Read-only. Nothing was claimed, translated or written.");
    log("Add --translate-one to translate this item.");
    return;
  }

  log("──────────────────────────────────────────────────────────────────────");
  log(`Translating EXACTLY ONE item: ${item.id}`);
  log(`Company: ${item.source.company.name} (${item.source.company.slug})`);
  log("");

  // Same production path as the list flow below: `translateFeedItems` → the real
  // `translateFeedItem` → the real atomic claim, quality gate, trace and DB write.
  // The override only narrows WHICH row is offered — it does not skip the claim.
  const summary = await translate(
    { companyId: item.companyId, limit: 1 },
    {
      findCandidates: async () => [
        {
          id: item.id,
          companyId: item.companyId,
          title: item.title,
          content: item.content,
          url: item.url,
          translationStatus: item.translationStatus,
          translationHash: item.translationHash,
          translationAttemptCount: item.translationAttemptCount,
          source: { type: item.source.type, config: item.source.config },
        },
      ],
    }
  );

  log("");
  log(`Summary: ${JSON.stringify(summary)}`);
  log("");
  log("Inspect the stored result and its trace:");
  log(`  npm run db:studio     → feed_items → ${item.id}`);
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

  if (args.id !== null) {
    await runById(args.id, args.translateOne);
    return;
  }

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

// Only run when executed directly (`npx tsx` / `npm run translate:next`), never on
// import — the test file imports `runById`/`parseArgs` as pure functions and must not
// trigger a live run (and its live DB connection) as a side effect of that import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
