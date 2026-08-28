import { getTranslations } from "next-intl/server";
import { postingWindowLines } from "@/lib/channels/posting-window-label";
import type { ChannelPublishingWindows } from "@/lib/channels/publishing-windows";

interface Props {
  /** Already narrowed to the current scope by `publishingWindowGroups`. */
  groups: ChannelPublishingWindows[];
}

/** Middot: the day and its hours are one reading, not two lines squashed together. */
const DAY_SEPARATOR = " · ";

/**
 * The publishing windows behind the calendar — when this company's channels are
 * set to post, above the grid showing what they actually posted.
 *
 * Purely a reading of `ChannelConfig.postingWindows` as saved. It plans nothing,
 * schedules nothing and is consulted by nothing: the windows are displayed
 * exactly as the owner typed them on Settings → Channels, with no default hour
 * invented for a channel that has none. A channel with no schedule is simply
 * absent, and with no channel scheduled the whole section is (returning null,
 * rather than an empty box that says nothing).
 *
 * TIMES ARE NOT CONVERTED. A window is a bare wall clock authored in the
 * business zone (lib/scheduling/posting-windows.ts), which is the same zone the
 * grid beside it renders in and the zone the toolbar directly above already
 * names — so "09:00" here is the 09:00 on every other clock on this page.
 * Reformatting it through a timezone would be the one way to make it wrong.
 */
export async function PublishingWindowsPanel({ groups }: Props) {
  if (groups.length === 0) return null;

  const t = await getTranslations("planner.calendar");
  const tChannels = await getTranslations("channels");

  // A day token this locale has no name for falls through unchanged rather than
  // throwing MISSING_MESSAGE in place of the row — same guard the settings card
  // uses over the same `channels.days.*` names.
  const dayLabel = (day: string) => (tChannels.has(`days.${day}`) ? tChannels(`days.${day}`) : day);

  return (
    <section
      aria-label={t("publishingWindows")}
      className="border-border bg-surface rounded-control border px-4 py-3"
    >
      <h2 className="text-fg-faint text-xs font-semibold tracking-wide uppercase">
        {t("publishingWindows")}
      </h2>

      <ul className="mt-2.5 flex flex-wrap gap-x-8 gap-y-3">
        {groups.map((group) => (
          <li key={group.channel} className="min-w-0">
            {/* Brand name, not translated — matching the channel switcher. */}
            <p className="text-fg text-sm font-semibold">{group.label}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {postingWindowLines(group.windows, dayLabel, DAY_SEPARATOR).map((line, index) => (
                <span
                  key={`${group.channel}-${index}`}
                  className="bg-surface-subtle text-fg-muted rounded-full px-2.5 py-0.5 text-xs tabular-nums"
                >
                  {line}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
