/**
 * Which social network the Channels area is currently looking at.
 *
 * The area has one axis the rest of the workspace does not: everything in it is
 * either about ONE network or about all of them at once. That choice lives in
 * the URL (`/companies/acme/channels/facebook/calendar`), so it has to survive a
 * reload, a shared link, and a channel being disconnected in settings after the
 * link was sent. This module owns the three rules that follow from that:
 *
 *  1. **What is on offer.** A network appears only when the company can actually
 *     publish to it. That question already has one answer in this codebase —
 *     `resolveGenerationChannels`, which requires an enabled ChannelConfig backed
 *     by a real Buffer profile — and it is reused rather than restated. A second
 *     definition of "this company has Instagram" would eventually disagree with
 *     the first, and the disagreement would show up as a tab that lists posts the
 *     generation form refuses to write.
 *
 *  2. **What an unknown scope means.** A stale or misspelled segment falls back
 *     to "all channels" rather than 404ing, matching `resolvePerformanceChannel`:
 *     links outlive channel connections, and the honest answer to "your Instagram
 *     is gone" is the view that still has content in it.
 *
 *  3. **Which posts belong to the scope.** One predicate, used by the calendar
 *     and by the channel posts list, so the two can never disagree about what
 *     "All Channels" includes.
 *
 * Pure — no Prisma, no React — so all of it is testable without a database.
 */

import { CHANNEL_ORDER, channelSortIndex } from "@/lib/posts/channel-selection";
import { resolveGenerationChannels } from "@/lib/posts/generation-channels";
import type { ChannelConfigItem } from "@/lib/services/company/list-channel-configs.service";

/**
 * The scope value meaning "every network this company has".
 *
 * Uppercase like the channel values beside it, so a scope is one string type
 * rather than a union of a channel and a magic lowercase word.
 */
export const ALL_CHANNELS = "ALL";

/** Either `ALL_CHANNELS` or an uppercase `SocialChannel` value. */
export type ChannelScope = string;

/** The URL segment for a scope — lowercase, matching the `[channel]` route param. */
export function channelScopeSlug(scope: ChannelScope): string {
  return scope.toLowerCase();
}

/**
 * The networks this company may browse, in canonical display order.
 *
 * Derived from the same rule generation uses (see above). A company that has
 * connected nothing gets an empty list, which is a real state the area reports
 * rather than an error.
 */
export function availableChannels(configs: readonly ChannelConfigItem[]): string[] {
  return resolveGenerationChannels(configs)
    .map((option) => option.channel)
    .sort((a, b) => channelSortIndex(a) - channelSortIndex(b));
}

/**
 * The scopes the area's channel switcher offers: "All Channels" first, then one
 * per available network.
 *
 * "All Channels" is offered even when the company has exactly one network. It is
 * the area's home and the destination every fallback resolves to, so a company
 * that connects a second network should not find the switcher suddenly growing a
 * new first entry it had never seen.
 */
export function channelScopeOptions(configs: readonly ChannelConfigItem[]): ChannelScope[] {
  return [ALL_CHANNELS, ...availableChannels(configs)];
}

/**
 * The scope a URL segment names, given what exists.
 *
 * Anything unrecognised — a typo, a network the company disconnected, a repeated
 * query parameter — resolves to `ALL_CHANNELS`. Callers compare the result
 * against what they were given to decide whether to redirect, which is how a
 * stale link gets its address bar corrected instead of quietly rendering under
 * the wrong one.
 */
export function resolveChannelScope(
  available: readonly string[],
  raw: string | string[] | undefined
): ChannelScope {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return ALL_CHANNELS;

  const normalized = value.trim().toUpperCase();
  if (normalized === ALL_CHANNELS) return ALL_CHANNELS;
  return available.some((channel) => channel.toUpperCase() === normalized)
    ? normalized
    : ALL_CHANNELS;
}

/** Whether one post's channel belongs in the current scope. */
export function matchesChannelScope(channel: string, scope: ChannelScope): boolean {
  if (scope === ALL_CHANNELS) return true;
  return channel.trim().toUpperCase() === scope.toUpperCase();
}

/**
 * Narrows a loaded list to the scope.
 *
 * `ALL_CHANNELS` returns everything the caller already has — including posts on
 * a network that has since been disconnected. That is deliberate: those posts
 * were published, and hiding a company's own history because a Buffer profile
 * was removed would make the calendar disagree with what actually went out. Only
 * the SWITCHER is limited to connected networks.
 */
export function filterPostsByChannelScope<T extends { channel: string }>(
  posts: readonly T[],
  scope: ChannelScope
): T[] {
  if (scope === ALL_CHANNELS) return [...posts];
  return posts.filter((post) => matchesChannelScope(post.channel, scope));
}

/**
 * The scope as a `SocialChannel` value for a Prisma `where`, or null for "do not
 * narrow at all". Lowercase, which is how the enum is spelled in the database.
 */
export function channelScopeFilter(scope: ChannelScope): string | null {
  return scope === ALL_CHANNELS ? null : scope.toLowerCase();
}

/** Re-exported so callers need only one import for the scope and its order. */
export { CHANNEL_ORDER };
