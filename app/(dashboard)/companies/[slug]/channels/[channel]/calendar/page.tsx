import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { ChannelsShell } from "@/components/company/channels-shell";
import { CalendarToolbar } from "@/components/company/calendar-toolbar";
import { PostCalendar } from "@/components/company/post-calendar";
import { listCalendarPosts } from "@/lib/services/company/list-calendar-posts.service";
import { channelScopeFilter, channelScopeSlug } from "@/lib/channels/channel-scope";
import {
  CALENDAR_DATE_PARAM,
  CALENDAR_VIEW_PARAM,
  buildCalendarRange,
  calendarWindowInstants,
  resolveCalendarAnchor,
  resolveCalendarView,
} from "@/lib/calendar/calendar-range";
import {
  CALENDAR_STATUS_PARAM,
  calendarStatusCounts,
  filterByCalendarStatus,
  resolveCalendarStatusFilter,
} from "@/lib/calendar/calendar-status-filter";
import { entriesWithinDays, placePosts } from "@/lib/calendar/calendar-entries";
import { appZoneToday } from "@/lib/scheduling/app-datetime-local";
import { loadChannelsContext } from "../../context";

interface Props {
  params: Promise<{ slug: string; channel: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Calendar – ${slug} – AI-First Post Assistant` };
}

export default async function ChannelCalendarPage({ params, searchParams }: Props) {
  const [{ slug, channel: channelParam }, sp] = await Promise.all([params, searchParams]);

  const view = resolveCalendarView(sp[CALENDAR_VIEW_PARAM]);
  // "Today" is today where the COMPANY is, not in UTC — the two disagree for
  // three hours every evening, which is exactly when someone opening the
  // calendar would otherwise be shown yesterday's week.
  const today = appZoneToday(new Date());
  const anchor = resolveCalendarAnchor(sp[CALENDAR_DATE_PARAM], today);
  const status = resolveCalendarStatusFilter(sp[CALENDAR_STATUS_PARAM]);

  // Canonical rather than passed through: every calendar link states all three
  // parameters, so a channel switch, an arrow press and a filter click all keep
  // the other two settings without any of them having to know about the others.
  const query = new URLSearchParams({
    [CALENDAR_VIEW_PARAM]: view,
    [CALENDAR_DATE_PARAM]: anchor,
    [CALENDAR_STATUS_PARAM]: status,
  }).toString();

  const context = await loadChannelsContext(slug, channelParam, "calendar", query);
  const { company, scopes, scope, role, canDelete, bufferConnected, user } = context;

  const range = buildCalendarRange(view, anchor);
  const window = calendarWindowInstants(range);

  const result = await listCalendarPosts(slug, user.id, user.isGlobalAdmin, {
    from: window.from,
    to: window.to,
    channel: channelScopeFilter(scope),
  });
  const posts = result.success ? result.posts : [];

  // Counts are over everything in the period, so a filter's label states how
  // many posts choosing it would reveal — not how many the current filter left.
  const counts = calendarStatusCounts(posts);

  const visible = filterByCalendarStatus(posts, status);
  const entries = entriesWithinDays(placePosts(visible), range.days);

  const t = await getTranslations("planner");
  const basePath = `/companies/${slug}/channels/${channelScopeSlug(scope)}/calendar`;

  return (
    <ChannelsShell
      company={company}
      user={{ name: user.name, email: user.email, isGlobalAdmin: user.isGlobalAdmin }}
      scopes={scopes}
      scope={scope}
      view="calendar"
      query={query}
    >
      {scopes.length === 1 && entries.length === 0 ? (
        /* Only "All Channels" on offer means nothing is connected at all, and
           an empty grid would leave the user to work out why. Both halves are
           required: a company that disconnected its last profile still has the
           posts it published, and hiding its own history behind a setup notice
           would be worse than the notice is helpful. */
        <EmptyState
          icon={<CalendarDays className="h-5 w-5" />}
          title={t("noChannels.title")}
          description={t("noChannels.description")}
        />
      ) : (
        <div className="space-y-4">
          <CalendarToolbar
            basePath={basePath}
            query={query}
            range={range}
            today={today}
            status={status}
            counts={counts}
          />
          <PostCalendar
            slug={slug}
            view={range.view}
            days={range.days}
            anchor={range.anchor}
            today={today}
            entries={entries}
            role={role}
            canDelete={canDelete}
            bufferConnected={bufferConnected}
            isGlobalAdmin={user.isGlobalAdmin}
          />
        </div>
      )}
    </ChannelsShell>
  );
}
