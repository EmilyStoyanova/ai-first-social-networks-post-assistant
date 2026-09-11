/**
 * The provider registry — the only place the application maps a configured
 * provider id onto an implementation.
 *
 * A plain frozen record rather than a registration system: there is one provider,
 * adding a second is one line, and a plugin architecture for two entries would be
 * more machinery than the thing it manages.
 */

import type { ListingFeedProvider } from "./types";
import { qhtiListingProvider } from "./providers/qhti.provider";

const PROVIDERS: Readonly<Record<string, ListingFeedProvider>> = Object.freeze({
  [qhtiListingProvider.id]: qhtiListingProvider,
});

/** Every provider a source may be configured with, for the form's dropdown. */
export const LISTING_PROVIDERS: ReadonlyArray<{ id: string; label: string }> = Object.values(
  PROVIDERS
).map((p) => ({ id: p.id, label: p.label }));

/** Valid provider ids, for the config validator's enum. */
export const LISTING_PROVIDER_IDS = Object.keys(PROVIDERS) as [string, ...string[]];

/** The provider for an id, or null when the id is unknown (a deleted provider). */
export function getListingProvider(id: string): ListingFeedProvider | null {
  return PROVIDERS[id] ?? null;
}
