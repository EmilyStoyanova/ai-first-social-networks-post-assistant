import { prisma } from "@/lib/db/client";
import {
  POST_ITEM_SELECT,
  toPostItem,
  type PostItem,
} from "@/lib/services/company/list-posts.service";

/**
 * The posts one calendar screen has to draw.
 *
 * A windowed read rather than `listPosts` + a client-side filter, because the
 * calendar shows one week or one month while a company's post history grows
 * without bound — the posts grid can afford to load everything and narrow in the
 * browser, a calendar of 2027 cannot.
 *
 * The shape returned is `PostItem`, identical to the grid's, and built from the
 * same select and the same mapper. That is what lets a calendar cell open the
 * real `GeneratedPostCard` — with its editing, approval, scheduling, publishing
 * and activity — instead of a second, thinner post UI that would then have to be
 * kept in step with the first.
 */

export interface CalendarPostsWindow {
  /** Inclusive lower bound — the instant the first visible day begins. */
  from: Date;
  /** EXCLUSIVE upper bound — the instant the day after the last visible day begins. */
  to: Date;
  /**
   * A lowercase `SocialChannel` to narrow to, or null for every channel.
   *
   * Comes from `channelScopeFilter`, so "All Channels" is the absence of a
   * constraint rather than a list of four — a company that connects a fifth
   * network does not need this query changed.
   */
  channel: string | null;
}

export type ListCalendarPostsResult =
  { success: true; posts: PostItem[] } | { success: false; code: "NOT_FOUND" };

export async function listCalendarPosts(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  window: CalendarPostsWindow
): Promise<ListCalendarPostsResult> {
  let companyId: string;

  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { success: false, code: "NOT_FOUND" };
    companyId = company.id;
  } else {
    const membership = await prisma.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    companyId = membership.companyId;
  }

  const rows = await prisma.post.findMany({
    where: {
      companyId,
      ...(window.channel ? { channel: window.channel as never } : {}),
      // Either date can be the one the post is drawn at (see
      // lib/calendar/calendar-entries.ts), so a post qualifies on either. This
      // deliberately reads WIDER than the grid draws — a post scheduled inside
      // the window but published outside it comes back and is then dropped by
      // `entriesWithinDays`, which is the only place the two can be reconciled,
      // because the choice between the columns is per post.
      OR: [
        { scheduledFor: { gte: window.from, lt: window.to } },
        { publishedAt: { gte: window.from, lt: window.to } },
      ],
    },
    // Chronological, which is the order the grid wants and the order a cell
    // shows. `placePosts` sorts again on the resolved instant — this only keeps
    // the read itself index-friendly and deterministic.
    orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
    select: POST_ITEM_SELECT,
  });

  return { success: true, posts: rows.map(toPostItem) };
}
