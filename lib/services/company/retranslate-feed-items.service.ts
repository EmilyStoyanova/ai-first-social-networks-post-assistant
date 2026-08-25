import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { enqueueJob, type EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";
import { RSS_TRANSLATION_JOB_TYPE, RSS_TRANSLATION_DEDUPE_KEY } from "@/lib/queue/job-types";
import { resolveTranslationConfig } from "@/lib/ai/feed-item-translation";
import { resolveBrandGuidelinesAccess } from "./update-brand-guidelines.service";
import { RECLASSIFY_REOPEN_DATA, sourceBelongsToCompany } from "./reclassify-feed-items.service";

/**
 * Retranslation — reopening a source's articles for a fresh translation.
 *
 * The sibling of reclassify-feed-items.service.ts, deliberately built to the same
 * shape: an exported eligibility predicate, an exported reset payload, a scoped
 * request function behind the same authorization, and an enqueue of the EXISTING
 * drain. Nothing here calls a model. It flips rows back to `pending` and asks the
 * translation job to run — the same job type, the same dedupe key and the same
 * worker handler as the scheduled cron, a manual ingest, and the self-continuation.
 *
 * ── Why it exists ────────────────────────────────────────────────────────────
 * A translation that exhausts its five cross-run attempts is TERMINAL: the drain's
 * own filter is `translationAttemptCount < MAX_TRANSLATION_ATTEMPTS`, so the row is
 * never selected again by anything. Re-ingesting does not help either — ingestion
 * only reopens an item whose input hash CHANGED, and a re-listed article's text is
 * identical. Before this action the only way back was an UPDATE by hand.
 *
 * That is not a rare state. A protected-token rejection burns all three in-request
 * regenerations per attempt, so a spec-heavy article can spend its whole budget in
 * five runs and settle `failed` permanently — with the article's own text still
 * perfectly translatable once the classifier or the engine improves.
 */

/**
 * Which translation states may be reopened BY DEFAULT (`includeCompleted` false).
 *
 *   • `failed` — the state this action exists for, including the attempt-exhausted
 *     rows nothing else can reach.
 *
 * Everything else is either excluded on purpose or handled below:
 *
 *   • `pending` — ALREADY queued. Reopening it would reset an attempt budget the
 *     drain is about to spend, and report it as newly queued work when nothing
 *     changed. This is half of the duplicate-protection (see the module note).
 *   • `translating` with a LIVE lease — in flight behind a claim. Touching it would
 *     yank the row out from under a running worker.
 *   • `completed` — held out of the DEFAULT set because a successful translation
 *     must not be thrown away by an accidental click. It is NOT excluded from the
 *     feature: `includeCompleted` (below) is exactly the explicit, selectable
 *     control this comment used to say did not exist yet — see that parameter.
 *   • `skipped` — terminal by design, and both of its causes are already covered
 *     elsewhere: translation turned off for the source (re-enabling it plus the next
 *     ingest reopens the rows automatically, because their stored hash is null and
 *     therefore never matches), or an article with no text at all (which would be
 *     re-skipped without a model call, inflating the count this action reports with
 *     work that cannot happen). `includeCompleted` does not touch this branch —
 *     forcing a retranslation is meaningless for a row that has no translatable text.
 *
 * `translationStatus: null` on an ENABLED RSS SOURCE is included for exactly the
 * reason the reclassify predicate includes its own null case: the translation
 * columns were added nullable and unbackfilled, so an article ingested before v2-4
 * reads as `null` — not "translation does not apply", simply "never asked". Such a
 * row is invisible to the drain too (`translationSelectableWhere` matches only
 * pending/failed/expired-translating), so nothing in the system could ever reach it.
 *
 * A crashed `translating` claim whose lease has EXPIRED is included as well. The
 * drain recovers those on its own — but only while the row is still under the
 * attempt cap, and a row that crashed its way through all five is stuck in exactly
 * the way this action exists to undo.
 */
const RETRANSLATABLE_STATUSES = ["failed"] as const;

/**
 * The eligibility predicate, exported so the rule above is a test rather than a
 * comment.
 *
 * `usedInPost: false` mirrors `reclassifiableWhere` and carries the same meaning: an
 * article already written from is HISTORY. Its translation is the text a published
 * post was built on, and replacing it now would make the post's own record disagree
 * with the article it cites — while doing nothing for the post itself, which is
 * already written. `companyId` stays alongside `sourceId` for the same tenancy
 * reason it does there. Consumed articles stay out EVEN with `includeCompleted` —
 * forcing a redo is still a request about future output, and a published post's
 * article is not that.
 *
 * `includeCompleted` is the explicit, selectable escape hatch: an operator who
 * wants a genuinely BETTER translation of an article the pipeline already finished
 * — the classifier was narrowed, the engine changed, a earlier run's output reads
 * badly — can ask for it by name, on the same source-scoped button, rather than by
 * an UPDATE run by hand. Off by default: the button must not silently spend model
 * calls re-doing work that already succeeded.
 */
export function retranslatableWhere(
  companyId: string,
  sourceId: string | null,
  now: Date,
  includeCompleted = false
): Record<string, unknown> {
  return {
    companyId,
    ...(sourceId === null ? {} : { sourceId }),
    usedInPost: false,
    source: { enabled: true, type: "rss" },
    // An OR rather than `in: [..., null]`: Prisma's `in` matches values, never NULL,
    // so a null status has to be named as its own alternative.
    OR: [
      { translationStatus: { in: [...RETRANSLATABLE_STATUSES] } },
      { translationStatus: null },
      { translationStatus: "translating", translationLeaseExpiresAt: { lt: now } },
      // Added ONLY on explicit request. A completed row is matched unconditionally
      // on status — not on a hash comparison — because the whole point of asking is
      // to force a fresh attempt even when the ARTICLE has not changed at all.
      ...(includeCompleted ? [{ translationStatus: "completed" }] : []),
    ],
  };
}

/**
 * What a reopen WRITES — exported for the same reason the predicate is, because the
 * reset is load-bearing and invisible.
 *
 *   • `translationAttemptCount: 0` is the whole point. Without it an exhausted row
 *     returns to `pending` and is then refused by the drain's own
 *     `translationAttemptCount < MAX_TRANSLATION_ATTEMPTS` filter — reopened on
 *     paper, unreachable in fact.
 *   • `translationProgress` clears banked MADLAD batch progress from the run that
 *     failed. The schema is explicit that this column must not outlive its article's
 *     attempt; leaving it would resume a fresh translation from raw segments
 *     produced under the settings that just failed. Written as `Prisma.JsonNull`
 *     rather than a bare `null` because Prisma types a nullable Json column that
 *     way — and specifically the SAME sentinel translate-feed-item.service.ts
 *     already uses to clear it, so the two clears cannot mean different things.
 *   • `translationLeaseExpiresAt: null` releases a dead claim, so the row reads as
 *     queued rather than in-flight.
 *
 * Deliberately NOT written:
 *   • `title` / `content` / `url` and every source column — the extracted article is
 *     immutable source data and is what the retry re-reads.
 *   • `translatedTitle` / `translatedContent` — the previous output stays visible
 *     until a new one replaces it, exactly as reclassify keeps the old verdict, and
 *     right up until the new translation is written it is still what generation
 *     reads (`resolveFeedItemContent` only trusts a `completed` row — see
 *     feed-item-translation.ts — so a row sitting `pending` mid-retry still serves
 *     its LAST good translation, never a gap).
 *   • `translationHash` — overwritten by the claim, and useful provenance until then.
 *     The "nothing changed" short-circuit in translateFeedItem cannot fire on these
 *     rows anyway: it requires `translationStatus === "completed"`, and this sets
 *     `pending` — which is exactly what makes `includeCompleted` force a REAL model
 *     call even when the article's hash has not moved at all, rather than being
 *     silently skipped as unchanged.
 */
export const RETRANSLATE_REOPEN_DATA = {
  translationStatus: "pending",
  translationAttemptCount: 0,
  translationError: null,
  translationNextRetryAt: null,
  translationLeaseExpiresAt: null,
  translationProgress: Prisma.JsonNull,
} as const;

/**
 * Classification is reopened in the SAME write, reusing reclassify's own payload.
 *
 * Not scope creep — it is what makes a retranslation mean anything downstream. The
 * classification drain accepts an item whose translation has SETTLED, and `failed`
 * counts as settled, so a row eligible here has very often already been judged on
 * its ORIGINAL English text. Leaving that verdict in place would store a fresh
 * Bulgarian translation underneath a decision made from the English, and nothing
 * would ever re-ask: `classificationSelectableWhere` matches pending/failed only, so
 * a `completed` verdict is not revisited on a hash change the way a translation is.
 *
 * The ordering takes care of itself. This sets `classificationStatus: "pending"`
 * while translation goes to `pending` too, and the classification drain skips any
 * item whose translation has not settled — so the verdict waits for the new text
 * rather than racing it. Reusing RECLASSIFY_REOPEN_DATA rather than restating it
 * keeps the attempt-count reset (equally load-bearing there) from drifting apart.
 *
 * It costs nothing when the translation turns out identical: the drain recomputes
 * `classificationHash`, finds it unchanged, and settles the row without a model call.
 */
const REOPEN_DATA = { ...RETRANSLATE_REOPEN_DATA, ...RECLASSIFY_REOPEN_DATA } as const;

export interface RetranslateResult {
  /** Rows flipped back to `pending`. Zero means there was nothing to retry. */
  reopened: number;
  /** Null when nothing was reopened, so no drain was asked for. */
  enqueued: EnqueueJobResult | null;
}

/**
 * The real, caller-supplied request — as opposed to `RetranslateDeps`, which is
 * test-only injection. Mirrors the `options`/`deps` split `translateFeedItems`
 * already uses (see translate-feed-items.service.ts) so the two kinds of parameter
 * are never confused for one another.
 */
export interface RetranslateOptions {
  /**
   * Also reopen rows whose translation already SUCCEEDED. Off by default — see the
   * `completed` branch of the doc comment on `RETRANSLATABLE_STATUSES` and the one
   * on `retranslatableWhere` for why this is opt-in rather than automatic.
   */
  includeCompleted?: boolean;
}

/**
 * Reads `includeCompleted` out of an already-JSON-parsed request body, defensively.
 *
 * Lives here rather than in the route itself so it is a plain, testable function —
 * Node's test runner glob-expands any CLI path argument containing `[...]`
 * characters, which makes a `route.test.ts` file placed inside this app's
 * `[slug]/[sourceId]` directories unreachable by `npx tsx --test`, and every other
 * company-scoped route in this codebase is tested at exactly this seam for exactly
 * that reason. The route (see retranslate/route.ts) does the `req.json()` call and
 * its own try/catch for "no body" / "not JSON" — both collapse to `undefined` before
 * this function ever runs — so this only has to judge a value that DID parse.
 *
 * Anything present but not a literal boolean is ignored rather than trusted, since a
 * caller crafting the body by hand is not this route's audience.
 */
export function parseIncludeCompletedFromBody(body: unknown): boolean {
  if (body !== null && typeof body === "object" && "includeCompleted" in body) {
    const value = (body as Record<string, unknown>).includeCompleted;
    if (typeof value === "boolean") return value;
  }
  return false;
}

export interface RetranslateDeps {
  /** Flips eligible rows to pending; returns how many. `sourceId` null = whole company. */
  reopen?: (
    companyId: string,
    sourceId: string | null,
    includeCompleted: boolean
  ) => Promise<number>;
  enqueue?: () => Promise<EnqueueJobResult>;
  /** Whether this source actually has translation turned on. */
  translationEnabled?: (companyId: string, sourceId: string) => Promise<boolean>;
  now?: () => Date;
}

async function defaultReopen(
  companyId: string,
  sourceId: string | null,
  now: Date,
  includeCompleted: boolean
): Promise<number> {
  const result = await prisma.feedItem.updateMany({
    where: retranslatableWhere(companyId, sourceId, now, includeCompleted),
    data: { ...REOPEN_DATA },
  });
  return result.count;
}

function defaultEnqueue(): Promise<EnqueueJobResult> {
  return enqueueJob({
    type: RSS_TRANSLATION_JOB_TYPE,
    // The SHARED key, on purpose — the other half of the duplicate protection. A
    // translation run already queued or active absorbs this request instead of a
    // second run starting beside it, which is what the partial unique index
    // `jobs_dedupe_active_key` enforces. Nothing is lost: the run in flight
    // re-derives its work from the rows, which now include the ones just reopened.
    dedupeKey: RSS_TRANSLATION_DEDUPE_KEY,
    // Above the recurring sweeps: somebody pressed a button and is waiting.
    priority: 5,
  });
}

/**
 * Whether the source has translation enabled at all.
 *
 * Checked so the count reported back is TRUE. Without it, a source whose translation
 * was turned off would still flip its failed rows to `pending` and answer "42
 * articles queued for retranslation" — and the drain would then quietly mark all 42
 * `skipped`, because `translateFeedItems` re-reads the source config per item. Zero
 * is the honest answer, and it is the same answer the UI already knows how to say.
 */
async function defaultTranslationEnabled(companyId: string, sourceId: string): Promise<boolean> {
  const source = await prisma.contentSource.findFirst({
    where: { id: sourceId, companyId },
    select: { type: true, config: true, company: { select: { defaultLang: true } } },
  });
  if (source === null) return false;
  return resolveTranslationConfig(source.type, source.config, source.company.defaultLang).enabled;
}

/**
 * Reopens a source's retryable translations and asks for a drain.
 *
 * Idempotent in the way that matters, exactly as reclassification is. A second click
 * matches only what the drain has not already moved on (`pending` and live claims are
 * not eligible — and, with `includeCompleted`, a row already reopened once has since
 * left `completed` too), and the second enqueue is absorbed by the dedupe key.
 */
export async function retranslateSourceFeedItems(
  companyId: string,
  sourceId: string | null,
  options: RetranslateOptions = {},
  deps: RetranslateDeps = {}
): Promise<RetranslateResult> {
  const includeCompleted = options.includeCompleted ?? false;
  const now = deps.now ?? (() => new Date());
  const reopen = deps.reopen ?? ((c, s, ic) => defaultReopen(c, s, now(), ic));
  const enqueue = deps.enqueue ?? defaultEnqueue;

  const reopened = await reopen(companyId, sourceId, includeCompleted);
  if (reopened === 0) return { reopened: 0, enqueued: null };

  return { reopened, enqueued: await enqueue() };
}

export type RequestRetranslationResult =
  | { success: true; reopened: number; enqueued: boolean; deduplicated: boolean }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

export interface RequestRetranslationDeps extends RetranslateDeps {
  resolveAccess?: typeof resolveBrandGuidelinesAccess;
  /** True iff this source exists AND belongs to that company. */
  sourceBelongsToCompany?: (companyId: string, sourceId: string) => Promise<boolean>;
}

/**
 * The manual "Retranslate this source" action, scoped to ONE source.
 *
 * Same authorization as reclassification — owners and global admins — because it is
 * the same class of act on the same rows, and a non-member gets NOT_FOUND rather
 * than FORBIDDEN so the response cannot confirm the company exists. A source from
 * another company is NOT_FOUND for the same reason.
 *
 * `options.includeCompleted` passes straight through to `retranslateSourceFeedItems`
 * — this layer only resolves WHO is asking, never WHAT they asked for.
 *
 * It enqueues the existing drain and returns; no model call happens in the request.
 */
export async function requestRetranslation(
  slug: string,
  sourceId: string,
  userId: string,
  isGlobalAdmin: boolean,
  options: RetranslateOptions = {},
  deps: RequestRetranslationDeps = {}
): Promise<RequestRetranslationResult> {
  const resolveAccess = deps.resolveAccess ?? resolveBrandGuidelinesAccess;
  const belongs = deps.sourceBelongsToCompany ?? sourceBelongsToCompany;
  const translationEnabled = deps.translationEnabled ?? defaultTranslationEnabled;

  const access = await resolveAccess(slug, userId, isGlobalAdmin);
  if (!access.ok) return { success: false, code: access.code };

  // Checked before anything is written: an unowned source must leave every row in
  // the database exactly as it was.
  if (!(await belongs(access.companyId, sourceId))) {
    return { success: false, code: "NOT_FOUND" };
  }

  // A disabled source is not an error — it simply has no retranslatable work, and
  // saying so honestly is better than queueing rows the drain will only skip.
  if (!(await translationEnabled(access.companyId, sourceId))) {
    console.info(
      "[rss-translation] manual retranslation requested for a source with translation off",
      {
        companyId: access.companyId,
        sourceId,
      }
    );
    return { success: true, reopened: 0, enqueued: false, deduplicated: false };
  }

  const result = await retranslateSourceFeedItems(access.companyId, sourceId, options, deps);

  console.info("[rss-translation] manual retranslation requested", {
    companyId: access.companyId,
    sourceId,
    includeCompleted: options.includeCompleted ?? false,
    reopened: result.reopened,
    enqueued: result.enqueued?.enqueued ?? false,
    deduplicated: result.enqueued?.deduplicated ?? false,
  });

  return {
    success: true,
    reopened: result.reopened,
    enqueued: result.enqueued?.enqueued ?? false,
    deduplicated: result.enqueued?.deduplicated ?? false,
  };
}
