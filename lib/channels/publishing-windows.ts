/**
 * Which publishing windows the Channels calendar shows, for the scope it is
 * currently looking at.
 *
 * The calendar grid answers "what is planned"; the windows answer "when would
 * anything be planned at all". A user reading a week with three posts in it has
 * no way to tell whether that is the schedule working or the schedule missing,
 * and the answer already exists — it is what the owner typed on Settings →
 * Channels. This module decides which of those saved schedules belong on the
 * page.
 *
 * Which channels may appear is `isPublishableChannelConfig` — the same enabled
 * and Buffer-backed rule the channel switcher is built from (see
 * channel-scope.ts), shared rather than restated. A network the switcher offers
 * is a network whose windows this shows, and neither can start listing
 * something the other does not.
 *
 * SEVERAL PROFILES ON ONE NETWORK CONTRIBUTE ALL OF THEIR WINDOWS. Two Facebook
 * pages are two config rows and one channel, and the calendar is addressed by
 * channel — but the collapse is a UNION, not a first-row-wins pick like
 * `resolveGenerationChannels` makes. That difference is deliberate and is the
 * whole reason this does not simply reuse that function's output:
 *
 *   • The weekly cron reads channel configs ROW BY ROW
 *     (generate-weekly-schedule.service.ts) and applies each row's own windows.
 *     Every eligible row's schedule is therefore live, and a display that
 *     showed one row's would be describing a subset of what actually publishes.
 *   • Rows arrive ordered by profile name, so WHICH row comes first is
 *     incidental. Reading windows off the first one meant a network whose
 *     alphabetically-first page had no schedule vanished from this section
 *     entirely while its other page went on posting — the schedule was there,
 *     the collapse hid it.
 *
 * Identical windows across two profiles are shown once: that is one line of
 * schedule to read, not two identical chips. Windows from a profile that is
 * switched off are not shown at all — the network stays on offer because
 * another page is enabled, but a disabled page's schedule is not part of what
 * that network publishes.
 *
 * NO DEFAULTS. A channel with nothing saved yields no group, and no group
 * yields no section (see lib/scheduling/posting-windows.ts, which refuses to
 * invent an hour for the same reason). "Nothing configured" is a real answer
 * this page is allowed to give by staying silent.
 *
 * Pure — no Prisma, no React, no next-intl. Day names are localised at render
 * time by `postingWindowLines`.
 */

import { matchesChannelScope, type ChannelScope } from "@/lib/channels/channel-scope";
import { channelLabel, channelSortIndex } from "@/lib/posts/channel-selection";
import { isPublishableChannelConfig } from "@/lib/posts/generation-channels";
import type {
  ChannelConfigItem,
  PostingWindow,
} from "@/lib/services/company/list-channel-configs.service";

/** One network's saved schedule, ready to render under its own heading. */
export interface ChannelPublishingWindows {
  /** Uppercase `SocialChannel` value, e.g. `FACEBOOK`. */
  channel: string;
  /** Brand name — never translated, matching the switcher and the post badges. */
  label: string;
  /** At least one; a channel with none never becomes a group. */
  windows: PostingWindow[];
}

/** Same window, saved twice — one line of schedule, whatever it was saved on. */
function isSameWindow(a: PostingWindow, b: PostingWindow): boolean {
  return a.day === b.day && a.start === b.start && a.end === b.end;
}

/**
 * The groups the calendar renders above its grid, in canonical channel order.
 *
 * `ALL_CHANNELS` returns every configured network; a specific scope returns at
 * most its own. Either way a network with no saved windows is left out entirely
 * rather than shown as empty, so the section's presence always means "there is
 * a schedule here to read".
 *
 * Windows keep the order they were saved in, profile by profile — the same
 * reasoning `postingWindowLines` documents: a schedule read back in a different
 * order than it was authored reads as a different schedule. The CHANNELS are
 * ordered by `channelSortIndex` instead of by the order the configs arrived in,
 * so the list matches the switcher above it and does not reshuffle when a
 * Buffer profile is renamed.
 */
export function publishingWindowGroups(
  configs: readonly ChannelConfigItem[],
  scope: ChannelScope
): ChannelPublishingWindows[] {
  const byChannel = new Map<string, PostingWindow[]>();

  for (const config of configs) {
    if (!isPublishableChannelConfig(config)) continue;

    const channel = config.channel.toUpperCase();
    if (!matchesChannelScope(channel, scope)) continue;

    const windows = byChannel.get(channel) ?? [];
    for (const window of config.postingWindows ?? []) {
      if (!windows.some((existing) => isSameWindow(existing, window))) windows.push(window);
    }
    byChannel.set(channel, windows);
  }

  return [...byChannel.entries()]
    .filter(([, windows]) => windows.length > 0)
    .map(([channel, windows]) => ({ channel, label: channelLabel(channel), windows }))
    .sort((a, b) => channelSortIndex(a.channel) - channelSortIndex(b.channel));
}
