/**
 * The round trip between the bulk generation form and the content-mix settings.
 *
 * "Configure content mix" is a link out of a half-filled form. Followed
 * naively it costs the user everything they had typed — channel, period,
 * per-day times, the batch's own mix — to change one number two pages away. So
 * the trip is made explicitly: the form snapshots itself on the way out, the
 * settings page shows the way back, and the form restores itself on return.
 *
 * Three decisions shape what is here:
 *
 *   • The draft lives in `sessionStorage`, keyed by company. It is scratch state
 *     for one flow in one tab, not a preference: it must not outlive the tab,
 *     must not follow the user to another browser, and must never be confused
 *     with the saved mix, which is company configuration.
 *   • It is consumed once. `takeBulkDraft` reads and deletes in the same call,
 *     so a restored form leaves nothing behind to be restored again on a later,
 *     unrelated visit.
 *   • The return trip is a marker, not a URL. `?from=bulk` says "there is a way
 *     back"; the href is rebuilt from the slug. Echoing a caller-supplied URL
 *     into a link is how open redirects start, and this needs no such thing —
 *     there is exactly one page the bulk form lives on.
 *
 * Everything below is pure except the three `sessionStorage` wrappers, so the
 * parsing — the part with edge cases — is testable without a browser.
 */

/**
 * Bumped whenever the draft's shape changes. A draft written by an older
 * deployment is dropped rather than half-read: a form restored from a shape it
 * does not understand is worse than one that simply opens fresh.
 */
const DRAFT_VERSION = 1;

/**
 * Mirrors `BulkPlanState` from `components/company/bulk-generate-fields.tsx`,
 * declared structurally rather than imported so a lib module does not reach up
 * into a component. The assignment back into `setPlan` on restore is what keeps
 * the two honest: if the state shape changes, that line stops compiling.
 */
export interface BulkDraftPlan {
  numberOfPosts: number;
  startDate: string;
  endDate: string;
  distribution: "even" | "custom";
  counts: Record<string, number>;
  times: Record<string, string[]>;
}

/** Everything the bulk form must look identical after, minus what it refetches. */
export interface BulkFormDraft {
  version: number;
  mode: "single" | "multiple";
  /** "" when the company has no connected channel to preselect. */
  channel: string;
  contentLanguage: "default" | "en" | "bg";
  imageOverride: "inherit" | "generate" | "skip";
  /** A sentinel or a content-source id; checked against the live list on restore. */
  contentSource: string;
  sourceLinkOverride: "inherit" | "include" | "exclude";
  /** "" = system default. */
  llmConfigId: string;
  plan: BulkDraftPlan;
  /** The batch's one-off mix; null = "untouched, use the saved default". */
  mixOverride: Record<string, number> | null;
}

/** What a caller hands in — the version is this module's business, not theirs. */
export type BulkFormDraftInput = Omit<BulkFormDraft, "version">;

// ─── The round-trip links ─────────────────────────────────────────────────────

/** Marks a settings visit as "arrived from the bulk form, and going back". */
export const BULK_RETURN_PARAM = "from";
export const BULK_RETURN_VALUE = "bulk";

/** Anchor ids, so the two ends of the trip cannot disagree on where to land. */
export const CONTENT_MIX_ANCHOR = "content-mix";
export const BULK_FORM_ANCHOR = "bulk-generate";

/**
 * The content-mix editor itself, not the settings page it sits at the bottom of.
 *
 * `fromBulk` is false for the ordinary in-app links to this page, which must
 * keep behaving exactly as they always have — no back link, no scrolling, no
 * draft in play.
 */
export function contentMixSettingsHref(slug: string, fromBulk: boolean): string {
  const query = fromBulk ? `?${BULK_RETURN_PARAM}=${BULK_RETURN_VALUE}` : "";
  return `/companies/${slug}/settings/channels${query}#${CONTENT_MIX_ANCHOR}`;
}

/** The bulk form, by anchor — the page also holds the whole post list. */
export function bulkGenerationHref(slug: string): string {
  return `/companies/${slug}/posts#${BULK_FORM_ANCHOR}`;
}

/** Whether a `searchParams` value asks for the way back to be shown. */
export function isReturnToBulk(value: string | string[] | undefined): boolean {
  const first = Array.isArray(value) ? value[0] : value;
  return first === BULK_RETURN_VALUE;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function isCountMap(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.values(value).every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function isTimesMap(value: unknown): value is Record<string, string[]> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (times) => Array.isArray(times) && times.every((t) => typeof t === "string")
    )
  );
}

function parsePlan(value: unknown): BulkDraftPlan | null {
  if (!isRecord(value)) return null;
  const distribution = oneOf(value.distribution, ["even", "custom"] as const);
  if (
    distribution === null ||
    typeof value.numberOfPosts !== "number" ||
    !Number.isFinite(value.numberOfPosts) ||
    typeof value.startDate !== "string" ||
    typeof value.endDate !== "string" ||
    !isCountMap(value.counts) ||
    !isTimesMap(value.times)
  ) {
    return null;
  }
  return {
    numberOfPosts: value.numberOfPosts,
    startDate: value.startDate,
    endDate: value.endDate,
    distribution,
    counts: value.counts,
    times: value.times,
  };
}

/**
 * A stored draft, or null when there is nothing usable to restore.
 *
 * Any bad field rejects the WHOLE draft rather than being dropped or defaulted.
 * A form restored from a partial snapshot is a form nobody filled in: the user
 * would have to spot which of a dozen fields quietly reverted, which is worse
 * than one that plainly opens fresh. Values are validated for shape only — that
 * the restored channel and source still exist is the form's question, since only
 * it knows what is on offer right now.
 */
export function parseBulkDraft(raw: string | null): BulkFormDraft | null {
  if (!raw) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== DRAFT_VERSION) return null;

  const mode = oneOf(value.mode, ["single", "multiple"] as const);
  const contentLanguage = oneOf(value.contentLanguage, ["default", "en", "bg"] as const);
  const imageOverride = oneOf(value.imageOverride, ["inherit", "generate", "skip"] as const);
  const sourceLinkOverride = oneOf(value.sourceLinkOverride, [
    "inherit",
    "include",
    "exclude",
  ] as const);
  const plan = parsePlan(value.plan);

  if (
    mode === null ||
    contentLanguage === null ||
    imageOverride === null ||
    sourceLinkOverride === null ||
    plan === null ||
    typeof value.channel !== "string" ||
    typeof value.contentSource !== "string" ||
    typeof value.llmConfigId !== "string"
  ) {
    return null;
  }

  // null is a meaningful value here ("use the saved default"), so it is kept as
  // itself rather than collapsed into an empty object.
  const mixOverride = value.mixOverride === null ? null : value.mixOverride;
  if (mixOverride !== null && !isCountMap(mixOverride)) return null;

  return {
    version: DRAFT_VERSION,
    mode,
    channel: value.channel,
    contentLanguage,
    imageOverride,
    contentSource: value.contentSource,
    sourceLinkOverride,
    llmConfigId: value.llmConfigId,
    plan,
    mixOverride,
  };
}

/** What a draft is stored under. Per company: two tabs, two companies, two drafts. */
export function bulkDraftKey(slug: string): string {
  return `bulk-generate-draft:${slug}`;
}

/**
 * A restored value, or the fallback when what was saved is no longer on offer —
 * a channel disconnected, or a content source deleted, while the user was away.
 */
export function stillAvailable<T extends string>(
  value: string,
  allowed: readonly string[],
  fallback: T
): T {
  return allowed.includes(value) ? (value as T) : fallback;
}

// ─── sessionStorage ───────────────────────────────────────────────────────────

/**
 * Storage can be absent (server render) or throw (Safari private browsing, or a
 * blocked third-party context). Every caller here treats that as "no draft",
 * which costs the user a re-typed form and nothing else — never an exception out
 * of a render or a click handler.
 */
function draftStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveBulkDraft(slug: string, draft: BulkFormDraftInput): void {
  const store = draftStorage();
  if (!store) return;
  try {
    store.setItem(bulkDraftKey(slug), JSON.stringify({ ...draft, version: DRAFT_VERSION }));
  } catch {
    // Quota or a blocked store: the trip still works, the form just opens fresh.
  }
}

/**
 * The stored draft, removed as it is read.
 *
 * Consuming it here is what keeps the restore tied to this one trip: nothing is
 * left behind to reapply itself the next time the page is opened for an
 * unrelated reason.
 */
export function takeBulkDraft(slug: string): BulkFormDraft | null {
  const store = draftStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(bulkDraftKey(slug));
    store.removeItem(bulkDraftKey(slug));
    return parseBulkDraft(raw);
  } catch {
    return null;
  }
}

export function clearBulkDraft(slug: string): void {
  const store = draftStorage();
  if (!store) return;
  try {
    store.removeItem(bulkDraftKey(slug));
  } catch {
    // Nothing to do — an unreachable store holds no draft to begin with.
  }
}
