"use client";

import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { usePostOriginLabel } from "@/lib/i18n/post-origin-label";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { StatusBadge, type PostStatusValue } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { LinkifiedText } from "@/components/ui/LinkifiedText";
import type { PostItem } from "@/lib/services/company/list-posts.service";
import type { BufferProfileItem } from "@/lib/services/buffer/list-buffer-profiles.service";
import { EditPostModal } from "./edit-post-modal";
import { PostActivityModal } from "./post-activity-modal";
import { GenerationTraceModal } from "@/components/admin/generation-trace-modal";
import { PostSchedulePanel } from "./post-schedule-panel";
import { ImagePickerModal, type GalleryMediaItem } from "@/components/media/ImagePickerModal";
import { formatDateTime } from "@/lib/i18n/format-date";
import { canReschedule } from "@/lib/scheduling/reschedule-policy";
import { resolvePostActions, type PostRole } from "@/lib/posts/post-actions";
import { PostMetricsStrip } from "./post-metrics-strip";
import type { PostMetricsView } from "@/lib/services/analytics/get-post-metrics.service";

/** A store that never changes — only the server/client snapshot split is wanted. */
const NEVER_CHANGES = () => () => {};

type BadgeVariant =
  "owner" | "editor" | "comingSoon" | "success" | "warning" | "danger" | "neutral" | "readonly";

const CHANNEL_META: Record<string, { label: string; variant: BadgeVariant }> = {
  FACEBOOK: { label: "Facebook", variant: "neutral" },
  LINKEDIN: { label: "LinkedIn", variant: "editor" },
  INSTAGRAM: { label: "Instagram", variant: "warning" },
  TIKTOK: { label: "TikTok", variant: "danger" },
};

/** The badge colours, reused by the version selector so switching looks the same. */
function channelMetaFor(channel: string): { label: string; variant: BadgeVariant } {
  return CHANNEL_META[channel] ?? { label: channel, variant: "neutral" };
}

const VERSION_SELECT_CLASSES: Record<BadgeVariant, string> = {
  owner: "bg-status-success-bg text-status-success-fg",
  editor: "bg-surface-subtle text-fg-muted",
  comingSoon: "bg-surface-subtle text-fg-faint",
  success: "bg-status-success-bg text-status-success-fg",
  warning: "bg-status-warning-bg text-status-warning-fg",
  danger: "bg-status-danger-bg text-status-danger-fg",
  neutral: "bg-status-neutral-bg text-status-neutral-fg",
  readonly: "bg-surface-subtle text-fg-faint",
};

/**
 * The channel badge, turned into a picker.
 *
 * A native `<select>` wearing the badge's own colours, rather than a custom
 * popover: it is keyboard-operable, screen-reader-labelled and touch-friendly
 * for free, and on a control whose entire job is "choose one of at most four"
 * there is nothing a bespoke menu would add. The colours follow the SELECTED
 * channel, so the card's identity changes with it exactly as the badge's did.
 */
function ChannelVersionSelect({
  versions,
  selectedId,
  onSelect,
  label,
}: {
  versions: PostItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  label: string;
}) {
  const meta = channelMetaFor(versions.find((v) => v.id === selectedId)?.channel ?? "");

  return (
    <select
      aria-label={label}
      value={selectedId}
      onChange={(e) => onSelect(e.target.value)}
      className={`text-micro focus:ring-accent/30 h-[22px] cursor-pointer appearance-none rounded-full border-0 py-0 pr-6 pl-2.5 font-medium outline-none focus:ring-2 ${VERSION_SELECT_CLASSES[meta.variant]}`}
      // The caret. Inline because the control is a coloured pill rather than a
      // form field, and Tailwind's form reset strips the native one.
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 5' fill='none'%3E%3Cpath d='M1 1l3 3 3-3' stroke='currentColor' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 0.5rem center",
        backgroundSize: "0.5rem",
      }}
    >
      {versions.map((v) => (
        <option key={v.id} value={v.id}>
          {channelMetaFor(v.channel).label}
        </option>
      ))}
    </select>
  );
}

interface Props {
  slug: string;
  /**
   * The channel versions of ONE content topic, in channel order.
   *
   * A single-element array for an ungrouped post, which is every post written
   * before multi-channel generation — those render exactly as they always have,
   * with a plain channel badge and no selector.
   */
  posts: PostItem[];
  canDelete: boolean;
  /** Drives which workflow actions the card offers — see lib/posts/post-actions.ts. */
  role: PostRole;
  bufferConnected: boolean;
  onDelete: (id: string) => void;
  onStatusChange?: (id: string, newStatus: string) => void;
  /**
   * A post's text or hashtags were saved. Reported for the same reason
   * `onStatusChange` is: the card repaints from its own state, but the record
   * lives in whatever owns the list, and a card that remounts — the channel
   * selector moving to a sibling and back — re-seeds from that record. A parent
   * that ignores this shows the pre-edit text again on the next remount.
   */
  onEdited?: (id: string, content: string, hashtags: string[]) => void;
  /** Engagement metrics by post id (v2-7). Optional so callers that do not
   *  show analytics (the approval queue) need not thread it through. */
  metrics?: Record<string, PostMetricsView>;
  canManageAnalyticsKey?: boolean;
  /**
   * Whether the viewer is a GLOBAL ADMIN, which is a stronger fact than the
   * `role` beside it — a company owner is also `"owner"`, and the generation
   * trace is not theirs to read. It carries the exact prompts, the raw model
   * replies and a frozen copy of the brand guidelines, so it is operator detail.
   *
   * This only decides whether the ACTION is offered; the API enforces the same
   * rule on its own (see the admin trace route), so a card rendered with the
   * wrong value cannot leak anything.
   */
  isGlobalAdmin?: boolean;
}

/**
 * One content topic, as a card.
 *
 * ── Why this is two components ──────────────────────────────────────────────
 *
 * The card below holds a great deal of per-post state: the text and hashtags as
 * they have been edited, the attached image, the live status, an open publish
 * panel with a chosen Buffer profile, four in-flight flags and five error
 * strings. Every one of those belongs to ONE Post record. Switching the channel
 * selector to a sibling while any of it survived would show that sibling with
 * another post's text, another post's image, or another post's error — and the
 * publish panel would send the wrong one.
 *
 * Reset by REMOUNT rather than by an effect that clears a dozen setters: `key`
 * is React's own guarantee that no state crosses, and it cannot be defeated by
 * someone adding a fourteenth `useState` later and forgetting to add it to a
 * reset list. Which is why the selection has to live OUT here — a remount that
 * also reset the selection would immediately switch back.
 *
 * The versions themselves are the posts that actually exist. A topic whose
 * LinkedIn generation failed simply has no LinkedIn option; an option that
 * selected nothing would be a broken control.
 */
export function GeneratedPostCard({
  slug,
  posts,
  canDelete,
  role,
  bufferConnected,
  onDelete,
  onStatusChange,
  onEdited,
  metrics,
  canManageAnalyticsKey = false,
  isGlobalAdmin = false,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Falls back to the first version whenever the remembered id is gone — the
  // ordinary consequence of deleting a sibling, not an edge case.
  const selected = posts.find((p) => p.id === selectedId) ?? posts[0];

  return (
    <GeneratedPostCardBody
      // The whole point: every `useState` below belongs to THIS post and is
      // discarded the moment another version is chosen.
      key={selected.id}
      slug={slug}
      post={selected}
      versions={posts}
      onSelectVersion={setSelectedId}
      canDelete={canDelete}
      role={role}
      bufferConnected={bufferConnected}
      onDelete={onDelete}
      onStatusChange={onStatusChange}
      onEdited={onEdited}
      metrics={metrics?.[selected.id]}
      canManageAnalyticsKey={canManageAnalyticsKey}
      isGlobalAdmin={isGlobalAdmin}
    />
  );
}

interface BodyProps {
  slug: string;
  post: PostItem;
  /** Every version of this topic — the selector's options. */
  versions: PostItem[];
  onSelectVersion: (id: string) => void;
  canDelete: boolean;
  role: PostRole;
  bufferConnected: boolean;
  onDelete: (id: string) => void;
  onStatusChange?: (id: string, newStatus: string) => void;
  onEdited?: (id: string, content: string, hashtags: string[]) => void;
  metrics?: PostMetricsView;
  canManageAnalyticsKey?: boolean;
  isGlobalAdmin?: boolean;
}

function GeneratedPostCardBody({
  slug,
  post,
  versions,
  onSelectVersion,
  canDelete,
  role,
  bufferConnected,
  onDelete,
  onStatusChange,
  onEdited,
  metrics,
  canManageAnalyticsKey = false,
  isGlobalAdmin = false,
}: BodyProps) {
  const t = useTranslations("posts");
  const tTrace = useTranslations("generationTrace");
  const tSchedule = useTranslations("posts.schedule");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const originLabelFor = usePostOriginLabel();

  // ── Approval state ────────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState("");

  // ── Delete state ──────────────────────────────────────────────────────────
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // ── Image state ───────────────────────────────────────────────────────────
  const [imageUrl, setImageUrl] = useState<string | null>(post.mediaUrl ?? null);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [imageError, setImageError] = useState("");

  // ── Edit state ────────────────────────────────────────────────────────────
  const [localText, setLocalText] = useState(post.text);
  const [localHashtags, setLocalHashtags] = useState<string[]>(post.hashtags);
  const [editOpen, setEditOpen] = useState(false);

  // ── Activity state ────────────────────────────────────────────────────────
  const [activityOpen, setActivityOpen] = useState(false);
  // Global admin only, and lazily mounted — the trace is a large fetch nobody
  // wants paid for on every card in a grid.
  const [traceOpen, setTraceOpen] = useState(false);

  // ── Schedule state ────────────────────────────────────────────────────────
  // Held here rather than in the panel because the schedule is not only the
  // panel's business: which workflow actions the card offers depends on it (a
  // post whose time is still ahead is approved, not published), so the card has
  // to see a newly chosen time immediately rather than after a page reload.
  const [scheduledFor, setScheduledFor] = useState<string | null>(post.scheduledFor);
  const [manuallyScheduled, setManuallyScheduled] = useState(post.manuallyScheduled);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  // ── Image picker state ────────────────────────────────────────────────────
  const [pickerOpen, setPickerOpen] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [galleryItems, setGalleryItems] = useState<GalleryMediaItem[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryError, setGalleryError] = useState("");

  // ── Publish state ─────────────────────────────────────────────────────────
  const [localStatus, setLocalStatus] = useState(post.status);
  const [publishOpen, setPublishOpen] = useState(false);
  const [profiles, setProfiles] = useState<BufferProfileItem[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [publishedPostUrl, setPublishedPostUrl] = useState<string | null>(
    post.publishedPostUrl ?? null
  );

  // ── Reconciling with the server ───────────────────────────────────────────
  // Everything above is seeded from `post` ONCE, at mount, and this component
  // does not remount when the list refreshes — it is keyed on `selected.id`
  // (GeneratedPostCard, above), which does not change just because a post's
  // status did. So a fresh `post` prop landing after a background refresh
  // (lib/posts/use-posts-live-refresh.ts, or the explicit refresh every action
  // already triggers) would otherwise sit unread: the badge, the schedule line
  // and the published block would keep showing whatever was true when the page
  // was opened, however many times the sweep moved the post along underneath.
  //
  // Adjusted DURING RENDER, not in an effect — the same pattern (and the same
  // reason) `GeneratedPostsSection` and `ChannelPostsSection` already use to
  // pick up a fresh `initialPosts` prop: `post` is a new object every time the
  // list refreshes (each server read maps fresh rows), so comparing it by
  // reference against the last one this card reconciled is exactly "did the
  // server send something new", and reacting to that inside render lets React
  // fold it into the render already in progress instead of committing stale
  // values and immediately re-rendering to fix them.
  //
  // Limited to the fields the SERVER moves on its own — status, the schedule,
  // and the published record — and none of the fields a person is mid-typing
  // into a form (text, hashtags, image). Those stay one-way, written back to
  // the list only through `onEdited` when a save actually commits, exactly as
  // today; reconciling them here would mean a background refresh landing
  // mid-edit silently overwriting a draft, which is precisely what this must
  // not do.
  //
  // A no-op whenever the fresh prop only confirms what an action on THIS card
  // already set locally (an approve/publish/reschedule this card just
  // performed, echoed back once its own `router.refresh()` resolves) — React
  // bails out of re-rendering on a `setState` call that does not change a
  // primitive's value. It only produces a visible change for a transition
  // nothing on this card initiated, which is the case this exists for.
  const [lastReconciledPost, setLastReconciledPost] = useState(post);
  if (post !== lastReconciledPost) {
    setLastReconciledPost(post);
    setLocalStatus(post.status);
    setScheduledFor(post.scheduledFor);
    setManuallyScheduled(post.manuallyScheduled);
    setPublishedAt(post.publishedAt);
    setPublishedPostUrl(post.publishedPostUrl ?? null);
  }

  const channelMeta = channelMetaFor(post.channel);

  // Origin badge — "RSS · TechPowerUp" for a post written from an article,
  // otherwise "Brand Setup". Text-only, matching the channel and status badges
  // beside it. The article headline rides along as a tooltip; the full detail
  // (source, article, link) lives in the activity modal.
  const origin = post.origin;
  const originLabel = originLabelFor(origin);

  // Client-only clock, for the single question that needs one: has a hand-chosen
  // publish time already gone by? The server's clock is not the viewer's, so
  // comparing during SSR would render an Approve button and hydrate a warning in
  // its place (React #418). This resolves undefined through hydration — which
  // reports the schedule as not missed — and the real instant afterwards, so the
  // warning appears in a second render rather than a mismatched first one. Same
  // pattern, and same reason, as the past-due notice in PostSchedulePanel.
  const hydrated = useSyncExternalStore(
    NEVER_CHANGES,
    () => true,
    () => false
  );

  // Which publish action the card offers never depends on the clock; only whether
  // approval is withheld pending a new time does.
  const actions = resolvePostActions({
    role,
    status: localStatus,
    bufferConnected,
    manuallyScheduled,
    scheduledFor,
    now: hydrated ? new Date() : undefined,
  });

  // The same rule the reschedule service enforces, asked before the control is
  // offered — so the card never proposes a schedule change the server refuses.
  const scheduleAllowed = canReschedule(localStatus, role === "owner");

  const isDraft = localStatus === "DRAFT";
  const isPendingApproval = localStatus === "PENDING_APPROVAL";
  const isApproved = localStatus === "APPROVED";
  const isRejected = localStatus === "REJECTED";
  const isSentToBuffer = localStatus === "SENT_TO_BUFFER";
  const isEditable = isDraft || isPendingApproval || isRejected;
  // Mirrors DELETABLE_POST_STATUSES on the server, which is what actually
  // enforces it — this only decides whether the button is worth offering.
  const isDeletable = isDraft || isRejected;

  // ── Lazy URL resolution for old published posts ───────────────────────────
  const urlFetchedRef = useRef(false);
  useEffect(() => {
    if (!isSentToBuffer || publishedPostUrl !== null || urlFetchedRef.current) return;
    urlFetchedRef.current = true;
    fetch(`/api/v1/posts/${post.id}/resolve-url`, { method: "POST" })
      .then((r) => r.json())
      .then((json: { publishedPostUrl?: string | null }) => {
        if (json.publishedPostUrl) setPublishedPostUrl(json.publishedPostUrl);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Edit ──────────────────────────────────────────────────────────────────
  /**
   * Called only after the save has been accepted — the modal throws on a failed
   * response and stays open, so nothing below ever runs on unsaved text.
   *
   * Local state first, because that is what this card paints; then the parent,
   * which owns the record. Both are the values the server reported writing, so
   * the two cannot disagree and a later refresh cannot roll either one back.
   */
  function handlePostSaved(newContent: string, newHashtags: string[]) {
    setLocalText(newContent);
    setLocalHashtags(newHashtags);
    onEdited?.(post.id, newContent, newHashtags);
  }

  // ── Approval ──────────────────────────────────────────────────────────────
  async function handleSubmitForApproval() {
    setSubmitting(true);
    setApprovalError("");
    try {
      const res = await fetch(`/api/v1/posts/${post.id}/submit`, { method: "POST" });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      setLocalStatus("PENDING_APPROVAL");
      onStatusChange?.(post.id, "PENDING_APPROVAL");
    } catch (err) {
      setApprovalError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Approve without publishing — the action for a post whose time is still
   * ahead. Goes through the plain approval route, so the post becomes `approved`
   * with its `scheduledFor` untouched and the publishing sweep sends it when due.
   */
  async function handleApproveOnly() {
    setApproving(true);
    setApprovalError("");
    try {
      const res = await fetch(`/api/v1/posts/${post.id}/approve`, { method: "POST" });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      setLocalStatus("APPROVED");
      onStatusChange?.(post.id, "APPROVED");
    } catch (err) {
      setApprovalError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setApproving(false);
    }
  }

  async function handleReject() {
    setRejecting(true);
    setApprovalError("");
    try {
      const res = await fetch(`/api/v1/posts/${post.id}/reject`, { method: "POST" });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      setLocalStatus("REJECTED");
      onStatusChange?.(post.id, "REJECTED");
    } catch (err) {
      setApprovalError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setRejecting(false);
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  async function handleDelete() {
    setDeleting(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/v1/companies/${slug}/posts/${post.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      onDelete(post.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  // ── Generate Image ────────────────────────────────────────────────────────
  async function handleGenerateImage() {
    setGeneratingImage(true);
    setImageError("");
    try {
      const res = await fetch(`/api/v1/posts/${post.id}/generate-image`, { method: "POST" });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { media: { id: string; url: string } };
      setImageUrl(json.media.url);
    } catch (err) {
      setImageError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setGeneratingImage(false);
    }
  }

  // ── Source article image ──────────────────────────────────────────────────
  // No action for it here, on purpose. Changing a post's image is one job with
  // one entry point — the image picker — where the article's image is a tab
  // beside the gallery, AI generation and upload. The card's only part in it is
  // deciding whether that tab is worth offering.
  const sourceImageUrl = post.sourceImageUrl ?? null;

  /**
   * Whether the picker offers a "Source article" tab.
   *
   * Offered whenever there IS an original article, even with no image stored
   * yet: items ingested before the column existed only get one when the tab asks
   * the server to resolve it. A known image implies an article, which covers a
   * legacy post whose frozen origin never recorded the source's kind.
   */
  const hasArticleSource =
    sourceImageUrl !== null || (origin.kind === "source" && origin.sourceType === "rss");

  // ── Gallery fetch (triggered from click handler, not a hook) ────────────
  async function loadGallery() {
    setGalleryLoading(true);
    setGalleryError("");
    try {
      const res = await fetch(`/api/v1/companies/${slug}/media?pageSize=48`);
      if (!res.ok) throw new Error(tCommon("somethingWentWrong"));
      const json = (await res.json()) as { media: GalleryMediaItem[] };
      setGalleryItems(json.media);
    } catch (err) {
      setGalleryError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setGalleryLoading(false);
    }
  }

  function handleOpenPicker() {
    setPickerOpen(true);
    void loadGallery();
  }

  // ── Remove Image ──────────────────────────────────────────────────────────
  async function handleRemoveImage() {
    setRemoveError("");
    try {
      const res = await fetch(`/api/v1/posts/${post.id}/detach-media`, { method: "POST" });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      setImageUrl(null);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    }
  }

  // ── Publish ───────────────────────────────────────────────────────────────
  async function handleOpenPublish() {
    setPublishOpen(true);
    setPublishError("");
    setLoadingProfiles(true);
    try {
      // Only this post's own network. Publishing a Facebook post to an Instagram
      // profile is not a choice worth offering, and approveAndPublishPost
      // refuses the pairing regardless of what the browser sends.
      const res = await fetch(
        `/api/v1/companies/${slug}/buffer/profiles?channel=${encodeURIComponent(post.channel)}`
      );
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { profiles: BufferProfileItem[] };
      setProfiles(json.profiles);
      setSelectedProfileId(json.profiles[0]?.id ?? "");
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setLoadingProfiles(false);
    }
  }

  async function handlePublish() {
    if (!selectedProfileId) return;
    setPublishing(true);
    setPublishError("");
    try {
      const res = await fetch(`/api/v1/posts/${post.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: selectedProfileId }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { publishedAt: string; publishedPostUrl?: string | null };
      setLocalStatus("SENT_TO_BUFFER");
      setPublishedAt(json.publishedAt);
      setPublishedPostUrl(json.publishedPostUrl ?? null);
      setPublishOpen(false);
      // Clears the card from the approval queue — for an owner this publish was
      // also the approval, so there is nothing left pending.
      onStatusChange?.(post.id, "SENT_TO_BUFFER");
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <Card className="flex flex-col px-5 py-5">
      {/* Header: badges + date */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* The channel badge IS the version selector on a grouped card — one
              control, in the place the channel was already shown, rather than a
              second "Version" dropdown saying the same thing twice. An ungrouped
              post has one version, so it keeps the plain badge it always had. */}
          {versions.length > 1 ? (
            <ChannelVersionSelect
              versions={versions}
              selectedId={post.id}
              onSelect={onSelectVersion}
              label={t("channelVersionLabel")}
            />
          ) : (
            <Badge variant={channelMeta.variant}>{channelMeta.label}</Badge>
          )}
          <StatusBadge status={localStatus.toLowerCase() as PostStatusValue} />
          <span
            title={
              origin.kind === "source" && origin.articleTitle
                ? origin.articleTitle
                : t("origin.tooltip")
            }
          >
            <Badge variant={origin.kind === "source" ? "accent" : "readonly"}>{originLabel}</Badge>
          </span>
        </div>
        <span className="text-fg-faint text-xs">{formatDateTime(post.createdAt)}</span>
      </div>

      {/* Post text */}
      <p className="text-fg mb-4 flex-1 text-sm leading-relaxed whitespace-pre-line">
        <LinkifiedText text={localText} />
      </p>

      {/* Hashtags */}
      {localHashtags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {localHashtags.map((tag) => (
            <span
              key={tag}
              className="bg-surface-subtle text-fg-muted rounded-full px-2.5 py-0.5 text-xs font-medium"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* Generated image preview */}
      {imageUrl && (
        <div className="rounded-control border-border mb-4 overflow-hidden border">
          <Image
            src={imageUrl}
            alt={t("imageAlt")}
            width={1200}
            height={630}
            className="w-full object-cover"
            unoptimized
          />
        </div>
      )}

      {/* Image prompt — shown only when there's no image yet */}
      {post.imagePrompt && !imageUrl && (
        <div className="rounded-control border-border bg-surface-subtle mb-3 border px-4 py-3">
          <p className="text-fg-faint mb-1 text-xs font-semibold tracking-wide uppercase">
            {t("imagePrompt")}
          </p>
          <p className="text-fg-muted text-xs leading-relaxed">{post.imagePrompt}</p>
        </div>
      )}

      {/* Notes */}
      {post.notes && (
        <div className="rounded-control border-border bg-surface-subtle mb-3 border px-4 py-3">
          <p className="text-fg-faint mb-1 text-xs font-semibold tracking-wide uppercase">
            {t("notes")}
          </p>
          <p className="text-fg-muted text-xs leading-relaxed">{post.notes}</p>
        </div>
      )}

      {/* Its chosen time went by with nobody approving it, so approval is
          withheld until there is a new one. Sits directly above the schedule
          panel, which is where the time is still shown and where the new one is
          picked — the Reschedule button in the action bar opens it. */}
      {actions.scheduleMissed && (
        <Alert variant="warning" role="status" className="mb-3">
          {tSchedule("missedBeforeApproval")}
        </Alert>
      )}

      {/* Publish time, and the form for choosing one. Renders nothing at all for
          an unscheduled post with the editor closed — the "Schedule" button in
          the action bar is what says so. */}
      <PostSchedulePanel
        postId={post.id}
        scheduledFor={scheduledFor}
        manuallyScheduled={manuallyScheduled}
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        onScheduled={(when) => {
          setScheduledFor(when);
          // What the server just wrote: a time a person picked is a promise,
          // whatever the post's schedule was before.
          setManuallyScheduled(true);
        }}
        // The post is further along than this card thought — the publishing
        // sweep sent it while the page was open. Repaint from what the server
        // says it is, so the badge tells the truth and the Reschedule button
        // stops being offered for a post that has already gone out. The list
        // owner is told too: this card can remount and re-seed from its record.
        // Deliberately NOT closing the editor: the explanation lives inside it,
        // and closing would repaint the card correctly while taking away the
        // sentence that says why. It closes when the user dismisses it, and the
        // button does not come back — `scheduleAllowed` is false by then.
        onLocked={(status) => {
          setLocalStatus(status);
          onStatusChange?.(post.id, status);
        }}
      />

      {/* Published info */}
      {publishedAt && (
        <div className="rounded-control bg-status-success-bg mb-3 border border-green-100 px-4 py-3">
          <p className="text-status-success-fg text-xs font-semibold">
            {t("sentToBuffer", { date: formatDateTime(publishedAt) })}
          </p>
        </div>
      )}

      {/* LLM info */}
      {(post.llmProvider || post.llmModel) && (
        <p className="text-fg-faint mb-4 text-xs">
          {[post.llmProvider, post.llmModel].filter(Boolean).join(" · ")}
        </p>
      )}

      {/* Image generation error */}
      {imageError && (
        <Alert variant="error" className="mb-3">
          {imageError}
        </Alert>
      )}

      {/* Remove image error */}
      {removeError && (
        <Alert variant="error" className="mb-3">
          {removeError}
        </Alert>
      )}

      {/* Delete error */}
      {deleteError && (
        <Alert variant="error" className="mb-3">
          {deleteError}
        </Alert>
      )}

      {/* Approval error */}
      {approvalError && (
        <Alert variant="error" className="mb-3">
          {approvalError}
        </Alert>
      )}

      {/* Auto-approved info — shown when the post was approved automatically (no human approver) */}
      {isApproved && post.approvedById === null && (
        <Alert variant="info" role="status" className="mb-3">
          {t("autoApprovedInfo")}
        </Alert>
      )}

      {/* Publish panel */}
      {publishOpen && (
        <div className="rounded-control border-status-info-dot/30 bg-status-info-bg mb-3 border px-4 py-3">
          <p className="text-status-info-fg mb-2 text-xs font-semibold">
            {t("publishPanel.title")}
          </p>
          {loadingProfiles ? (
            <p className="text-status-info-fg text-xs">{t("publishPanel.loadingProfiles")}</p>
          ) : profiles.length === 0 ? (
            <p className="text-status-info-fg text-xs">
              {t("publishPanel.noProfiles", { channel: channelMeta.label })}
            </p>
          ) : (
            <select
              value={selectedProfileId}
              onChange={(e) => setSelectedProfileId(e.target.value)}
              disabled={publishing}
              className="rounded-control border-status-info-dot/40 bg-surface focus:border-status-info-dot focus:ring-status-info-dot/30 mb-2 w-full border px-3 py-2 text-xs outline-none focus:ring-2"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.channel})
                </option>
              ))}
            </select>
          )}
          {publishError && (
            <Alert variant="error" className="mb-2">
              {publishError}
            </Alert>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={publishing}
              disabled={!selectedProfileId || loadingProfiles || profiles.length === 0}
              onClick={handlePublish}
            >
              {publishing ? t("publishPanel.publishing") : t("publishPanel.publish")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPublishOpen(false);
                setPublishError("");
              }}
            >
              {tCommon("cancel")}
            </Button>
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Image actions */}
        {isDraft && !imageUrl && (
          <Button variant="ghost" size="sm" onClick={handleOpenPicker}>
            {t("addImage")}
          </Button>
        )}
        {isDraft && imageUrl && (
          <>
            <Button variant="ghost" size="sm" onClick={handleOpenPicker}>
              {t("replaceImage")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void handleRemoveImage()}>
              {t("removeImage")}
            </Button>
          </>
        )}
        {!isDraft && post.imagePrompt && !imageUrl && (
          <Button variant="ghost" size="sm" loading={generatingImage} onClick={handleGenerateImage}>
            {generatingImage ? t("generatingImage") : t("generateImage")}
          </Button>
        )}
        {!isDraft && imageUrl && (
          <Button variant="ghost" size="sm" loading={generatingImage} onClick={handleGenerateImage}>
            {generatingImage ? t("generatingImage") : t("regenerateImage")}
          </Button>
        )}

        {/* Edit — draft / pending / rejected */}
        {isEditable && (
          <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)}>
            {tCommon("edit")}
          </Button>
        )}

        {/* Schedule — beside the other things a person does to a post, rather
            than tucked in with the metadata above. The label is the whole
            distinction between a scheduled post and an unscheduled one: a post
            with a promised time is being MOVED, one without is getting its
            first. An automatic post reads as unscheduled here on purpose — its
            time is the weekly filler's estimate, which nobody promised. */}
        {scheduleAllowed && !scheduleOpen && (
          <Button
            // Primary when the missed time is what is holding the post up: with
            // Approve withheld, picking a new time is the only step left, so it
            // takes the place Approve would have had.
            variant={actions.scheduleMissed ? "primary" : "secondary"}
            size="sm"
            onClick={() => setScheduleOpen(true)}
          >
            {manuallyScheduled && scheduledFor ? tSchedule("reschedule") : tSchedule("schedule")}
          </Button>
        )}

        {/* Submit for approval — an editor's hand-off to an owner */}
        {actions.submitForApproval && (
          <Button
            variant="secondary"
            size="sm"
            loading={submitting}
            onClick={handleSubmitForApproval}
          >
            {submitting ? t("submitting") : t("submitForApproval")}
          </Button>
        )}

        {/* The owner's single primary action — approves on the way out when needed */}
        {actions.approveAndPublish && !publishOpen && (
          <Button variant="primary" size="sm" onClick={handleOpenPublish}>
            {actions.approvalPending ? t("approveAndPublish") : t("publishToBuffer")}
          </Button>
        )}

        {/* Approve alone — its publish time is still ahead, so the sweep sends it */}
        {actions.approveOnly && (
          <Button variant="primary" size="sm" loading={approving} onClick={handleApproveOnly}>
            {approving ? t("approving") : t("approve")}
          </Button>
        )}
        {actions.awaitingSchedule && (
          <span className="text-fg-faint text-xs">{t("awaitingScheduledTime")}</span>
        )}
        {actions.connectBufferHint && (
          <span className="text-fg-faint text-xs">{t("connectBufferToPublish")}</span>
        )}

        {/* Reject — a real editorial decision on someone else's submission */}
        {actions.reject && (
          <Button variant="danger" size="sm" loading={rejecting} onClick={handleReject}>
            {rejecting ? t("rejecting") : t("reject")}
          </Button>
        )}

        {/* Open post — shown when a public URL is available */}
        {publishedPostUrl && (
          <a
            href={publishedPostUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-fg-muted hover:text-fg rounded-control border-border bg-surface inline-flex items-center gap-1.5 border px-3 py-1.5 text-xs font-medium transition-colors"
          >
            {t("openPost")} ↗
          </a>
        )}

        {/* Delete — draft or rejected, owner/admin. Both are posts that never
            left the building, so nothing outside this database survives them.
            The confirmation names which one, because deleting a rejected post is
            the more consequential of the two: it is the only way to stop a
            turned-down idea from reserving its topic against future generations. */}
        {canDelete &&
          isDeletable &&
          (confirmDelete ? (
            <>
              <p className="text-fg-muted text-xs">
                {isRejected ? t("deleteRejected") : t("deleteDraft")}
              </p>
              <Button variant="danger" size="sm" loading={deleting} onClick={handleDelete}>
                {deleting ? tCommon("deleting") : tCommon("confirm")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                {tCommon("cancel")}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirmDelete(true);
                setDeleteError("");
              }}
            >
              {tCommon("delete")}
            </Button>
          ))}
      </div>

      {/* Engagement metrics (v2-7) — only for posts that actually reached Buffer.
          A post that was never published has no Buffer counterpart to measure. */}
      {metrics && (isSentToBuffer || localStatus === "PUBLISHED") && (
        <PostMetricsStrip metrics={metrics} canManageKey={canManageAnalyticsKey} slug={slug} />
      )}

      {/* View Activity — always available. The generation trace sits beside it
          for a global admin only: same footer, but operator detail (exact
          prompts, raw model replies, a frozen copy of the brand guidelines)
          rather than the company-facing history the activity modal shows. */}
      <div className="border-border mt-3 flex flex-wrap gap-4 border-t pt-3">
        <button
          onClick={() => setActivityOpen(true)}
          className="text-fg-faint hover:text-fg text-xs transition-colors"
        >
          {t("viewActivity")}
        </button>

        {isGlobalAdmin && (
          <button
            onClick={() => setTraceOpen(true)}
            className="text-fg-faint hover:text-fg text-xs transition-colors"
          >
            {tTrace("open")}
          </button>
        )}
      </div>

      {editOpen && (
        <EditPostModal
          postId={post.id}
          initialContent={localText}
          initialHashtags={localHashtags}
          canRestore={role === "owner"}
          onClose={() => setEditOpen(false)}
          onSaved={handlePostSaved}
        />
      )}

      {activityOpen && (
        <PostActivityModal
          postId={post.id}
          // Passed down rather than refetched: the card already holds it, and a
          // second source of truth could disagree with the badge above.
          origin={origin}
          open={activityOpen}
          onClose={() => setActivityOpen(false)}
        />
      )}

      {traceOpen && (
        <GenerationTraceModal
          postId={post.id}
          open={traceOpen}
          onClose={() => setTraceOpen(false)}
        />
      )}

      {pickerOpen && (
        <ImagePickerModal
          postId={post.id}
          companySlug={slug}
          postImagePrompt={post.imagePrompt ?? null}
          hasArticleSource={hasArticleSource}
          sourceImageUrl={sourceImageUrl}
          galleryItems={galleryItems}
          galleryLoading={galleryLoading}
          galleryError={galleryError}
          onGalleryRetry={() => void loadGallery()}
          onClose={() => setPickerOpen(false)}
          onAttached={(media) => {
            setImageUrl(media.url);
            setPickerOpen(false);
          }}
        />
      )}
    </Card>
  );
}
