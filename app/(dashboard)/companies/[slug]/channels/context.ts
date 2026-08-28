import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getCompany, type CompanyDetails } from "@/lib/services/company/get-company.service";
import { getBufferConnection } from "@/lib/services/buffer/get-buffer-connection.service";
import {
  listChannelConfigs,
  type ChannelConfigItem,
} from "@/lib/services/company/list-channel-configs.service";
import {
  channelScopeOptions,
  channelScopeSlug,
  resolveChannelScope,
  type ChannelScope,
} from "@/lib/channels/channel-scope";
import type { ChannelsView } from "@/components/company/channels-shell";
import type { PostRole } from "@/lib/posts/post-actions";

/**
 * Everything all three Channels pages need before they can render anything:
 * who is asking, which company, which networks exist, and which one the URL
 * names.
 *
 * A plain function rather than a route `layout.tsx`, matching SettingsShell's
 * reasoning — a layout cannot hand its data to the page beneath it, so the two
 * would each run the same three queries per request.
 *
 * It also owns the redirect that makes a stale link honest. `/channels/tiktok`
 * for a company with no TikTok resolves to All Channels, and rewriting the
 * address bar to match is what stops the page from rendering everything under a
 * heading that says otherwise.
 */
export interface ChannelsContext {
  user: { id: string; name?: string | null; email?: string | null; isGlobalAdmin: boolean };
  company: CompanyDetails;
  /** The switcher's options — `ALL_CHANNELS` first. */
  scopes: ChannelScope[];
  scope: ChannelScope;
  /**
   * The company's channel configs, as loaded for the switcher.
   *
   * Handed on rather than re-queried: the scopes above are already derived from
   * these rows, and a page that needs the per-channel settings behind a scope
   * (the calendar shows the saved posting windows) would otherwise run the same
   * query a second time and be free to disagree with the switcher about what
   * exists.
   */
  configs: ChannelConfigItem[];
  /** Owner or global admin. Drives the card's actions and the delete button. */
  role: PostRole;
  canDelete: boolean;
  bufferConnected: boolean;
}

export async function loadChannelsContext(
  slug: string,
  channelParam: string,
  view: ChannelsView,
  query = ""
): Promise<ChannelsContext> {
  const session = await auth();
  if (!session) redirect("/login");

  const company = await getCompany(slug, session.user.id, session.user.isGlobalAdmin);
  if (!company) notFound();

  const [configsResult, bufferConnection] = await Promise.all([
    listChannelConfigs(slug, session.user.id, session.user.isGlobalAdmin),
    getBufferConnection(company.id),
  ]);

  const configs = configsResult.success ? configsResult.configs : [];
  const scopes = channelScopeOptions(configs);
  const scope = resolveChannelScope(scopes, channelParam);

  if (channelScopeSlug(scope) !== channelParam.trim().toLowerCase()) {
    const suffix = query ? `?${query}` : "";
    redirect(`/companies/${slug}/channels/${channelScopeSlug(scope)}/${view}${suffix}`);
  }

  const canManage = company.role === "OWNER" || session.user.isGlobalAdmin;

  return {
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      isGlobalAdmin: session.user.isGlobalAdmin,
    },
    company,
    scopes,
    scope,
    configs,
    role: canManage ? "owner" : "editor",
    canDelete: canManage,
    bufferConnected: bufferConnection.connected,
  };
}
