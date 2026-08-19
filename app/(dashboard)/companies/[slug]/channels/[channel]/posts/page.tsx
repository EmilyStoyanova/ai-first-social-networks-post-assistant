import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { ChannelsShell } from "@/components/company/channels-shell";
import { ChannelPostsSection } from "@/components/company/channel-posts-section";
import { listPosts } from "@/lib/services/company/list-posts.service";
import { filterPostsByChannelScope } from "@/lib/channels/channel-scope";
import { resolvePostStatusFilter } from "@/lib/posts/post-status-filter";
import { loadChannelsContext } from "../../context";

interface Props {
  params: Promise<{ slug: string; channel: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Channel posts – ${slug} – AI-First Post Assistant` };
}

export default async function ChannelPostsPage({ params, searchParams }: Props) {
  const [{ slug, channel: channelParam }, sp] = await Promise.all([params, searchParams]);

  const context = await loadChannelsContext(slug, channelParam, "posts");
  const { company, scopes, scope, role, canDelete, bufferConnected, user } = context;

  const result = await listPosts(slug, user.id, user.isGlobalAdmin);
  // Narrowed in memory rather than in the query, exactly as the status filter
  // already is: `listPosts` is one read the workspace shares, and the scope is a
  // question about posts already loaded.
  const posts = filterPostsByChannelScope(result.success ? result.posts : [], scope);

  const t = await getTranslations("planner");

  return (
    <ChannelsShell
      company={company}
      user={{ name: user.name, email: user.email, isGlobalAdmin: user.isGlobalAdmin }}
      scopes={scopes}
      scope={scope}
      view="posts"
    >
      {/* Nothing connected AND nothing written — see the note on the calendar
          page. A company with posts but no live profile keeps its grid. */}
      {scopes.length === 1 && posts.length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="h-5 w-5" />}
          title={t("noChannels.title")}
          description={t("noChannels.description")}
        />
      ) : (
        <ChannelPostsSection
          slug={slug}
          initialPosts={posts}
          canDelete={canDelete}
          role={role}
          bufferConnected={bufferConnected}
          initialStatusFilter={resolvePostStatusFilter(sp.status)}
          isGlobalAdmin={user.isGlobalAdmin}
        />
      )}
    </ChannelsShell>
  );
}
