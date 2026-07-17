/**
 * Manual content-source selection (the "Content source" dropdown).
 *
 * Applies to MANUAL generation only. The scheduled generator decides its source
 * from the content mix and never reads anything here — see
 * generate-weekly-schedule.service.ts, which builds its own SourceScope.
 *
 * The three choices map onto the SourceScope union the context builder already
 * understands, so this adds no new source-resolution path:
 *
 *   • company_rules   → pooled          — every enabled source, newest first.
 *                                         The pre-existing manual behaviour.
 *   • <source id>     → source          — that one source and nothing else.
 *   • company_mission → company_content — no sources at all; write from the
 *                                         company profile / brand.
 */

import type { SourceScope } from "@/lib/services/ai/build-generation-context.service";
import type { FeedItemContext } from "./types";
import { isConsumableItem } from "./source-types";

/**
 * Sentinel dropdown values. Namespaced with a `__` prefix so they can never
 * collide with a ContentSource id (a uuid), which is what every other value is.
 */
export const COMPANY_RULES_VALUE = "__company_rules__";
export const COMPANY_MISSION_VALUE = "__company_mission__";

export type ManualContentSourceSelection =
  { kind: "company_rules" } | { kind: "company_mission" } | { kind: "source"; sourceId: string };

/**
 * Resolves a raw dropdown value to a selection. An absent/empty value is the
 * default choice (company rules), which keeps a client that never sends the
 * field — and every pre-existing caller — on exactly the old behaviour.
 */
export function parseManualContentSource(
  raw: string | null | undefined
): ManualContentSourceSelection {
  if (!raw || raw === COMPANY_RULES_VALUE) return { kind: "company_rules" };
  if (raw === COMPANY_MISSION_VALUE) return { kind: "company_mission" };
  return { kind: "source", sourceId: raw };
}

/** Maps a selection onto the scope the context builder consumes. */
export function toSourceScope(selection: ManualContentSourceSelection): SourceScope {
  switch (selection.kind) {
    case "company_rules":
      return { kind: "pooled" };
    case "company_mission":
      return { kind: "company_content" };
    case "source":
      return { kind: "source", sourceId: selection.sourceId };
  }
}

/**
 * Whether a picked source can still back a post, given the context built for it.
 *
 * Only meaningful for a specific-source selection; the other two choices are
 * always usable (company rules pools whatever exists, company mission needs no
 * source at all).
 *
 * A source-scoped context window is already restricted to the chosen source, so
 * an empty article list here means the source cannot serve this generation —
 * whether because its articles are all used, or because it was disabled,
 * deleted, or never belonged to this company. All four are the same answer to
 * the user, and all four must refuse rather than fall back: a manual pick is an
 * explicit instruction, so quietly writing from some other source (or from the
 * mission) would publish content the user did not ask for.
 */
export function isSelectedSourceUsable(
  selection: ManualContentSourceSelection,
  feedItems: readonly Pick<FeedItemContext, "consumable">[]
): boolean {
  if (selection.kind !== "source") return true;
  return feedItems.some(isConsumableItem);
}
