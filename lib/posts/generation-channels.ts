import type {
  ChannelConfigItem,
  PostingWindow,
} from "@/lib/services/company/list-channel-configs.service";

/**
 * A channel the manual generation form may offer.
 *
 * The form's own CHANNELS constant still owns the label and the display order —
 * this only decides WHICH channels are offered and carries the per-channel
 * settings the form has to show: the resolved posting language, whether the
 * channel needs an image, and the posting windows.
 */
export interface GenerationChannelOption {
  /** Uppercase SocialChannel value, matching the form's CHANNELS constant. */
  channel: string;
  /** Explicit per-channel language, or null to inherit Company.defaultLang. */
  postingLanguage: string | null;
  /** Publishing on this channel requires an image — drives the image warning. */
  imageRequired: boolean;
  /**
   * The channel's configured posting windows, as stored.
   *
   * Carried into the browser so bulk generation can PREVIEW the days and times
   * it is about to schedule, by running the same pure planner the server runs
   * (`lib/scheduling/bulk-schedule.ts`). It is display configuration the owner
   * authored on the settings page, not data the form is trusted with: the
   * server re-reads the windows from the database when the request arrives and
   * never takes the client's word for a schedule.
   */
  postingWindows: PostingWindow[];
}

/**
 * Derives the channels a user may generate for from the company's channel
 * configs.
 *
 * A channel is offered only when it is BOTH connected and switched on:
 *
 *   • it came from a Buffer profile (`bufferProfileId != null`) — a row without
 *     one is a legacy config that was never backed by a real social account, and
 *     syncing deactivates those anyway (sync-buffer-profiles.service.ts);
 *   • the owner has enabled it on Settings → Channels (`enabled`).
 *
 * `isActive` is already enforced by `listChannelConfigs`, which never returns
 * deactivated rows, so it is not re-checked here.
 *
 * A company can hold several Buffer profiles for the same social network (two
 * Facebook pages = two rows, keyed `@@unique([companyId, bufferProfileId])`),
 * but generation is addressed by channel, not by profile. So rows collapse to
 * one option per channel and the first one wins its settings — the same
 * last-writer arbitrariness `loadBufferProfileMap` already lives with on the
 * publish side. Callers pass rows in `listChannelConfigs` order (channel, then
 * profile name), which makes "first" stable rather than incidental.
 */
export function resolveGenerationChannels(
  configs: readonly ChannelConfigItem[]
): GenerationChannelOption[] {
  const byChannel = new Map<string, GenerationChannelOption>();

  for (const config of configs) {
    if (!config.enabled || config.bufferProfileId === null) continue;

    const channel = config.channel.toUpperCase();
    if (byChannel.has(channel)) continue;

    byChannel.set(channel, {
      channel,
      postingLanguage: config.postingLanguage,
      imageRequired: config.imageRequired,
      postingWindows: config.postingWindows ?? [],
    });
  }

  return [...byChannel.values()];
}
