"use client";

import { useState } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { StatusBadge, type PostStatusValue } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { PostItem } from "@/lib/services/company/list-posts.service";
import type { BufferProfileItem } from "@/lib/services/buffer/list-buffer-profiles.service";
import { EditPostModal } from "./edit-post-modal";
import { PostActivityModal } from "./post-activity-modal";
import { ImagePickerModal, type GalleryMediaItem } from "@/components/media/ImagePickerModal";

type BadgeVariant =
  "owner" | "editor" | "comingSoon" | "success" | "warning" | "danger" | "neutral" | "readonly";

const CHANNEL_META: Record<string, { label: string; variant: BadgeVariant }> = {
  FACEBOOK: { label: "Facebook", variant: "neutral" },
  LINKEDIN: { label: "LinkedIn", variant: "editor" },
  INSTAGRAM: { label: "Instagram", variant: "warning" },
  TIKTOK: { label: "TikTok", variant: "danger" },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface Props {
  slug: string;
  post: PostItem;
  canDelete: boolean;
  canPublish: boolean;
  canApprove: boolean;
  bufferConnected: boolean;
  onDelete: (id: string) => void;
  onStatusChange?: (id: string, newStatus: string) => void;
}

export function GeneratedPostCard({
  slug,
  post,
  canDelete,
  canPublish,
  canApprove,
  bufferConnected,
  onDelete,
  onStatusChange,
}: Props) {
  const t = useTranslations("posts");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();

  // ── Approval state ────────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [approvalError, setApprovalError] = useState("");
  // Tracks if the current user manually approved in this session, so the
  // auto-approved banner doesn't appear after a same-session approval.
  const [approvedByUser, setApprovedByUser] = useState(false);

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

  const channelMeta = CHANNEL_META[post.channel] ?? {
    label: post.channel,
    variant: "neutral" as BadgeVariant,
  };

  const isDraft = localStatus === "DRAFT";
  const isPendingApproval = localStatus === "PENDING_APPROVAL";
  const isApproved = localStatus === "APPROVED";
  const isRejected = localStatus === "REJECTED";
  const isEditable = isDraft || isPendingApproval || isRejected;

  // ── Edit ──────────────────────────────────────────────────────────────────
  function handlePostSaved(newContent: string, newHashtags: string[]) {
    setLocalText(newContent);
    setLocalHashtags(newHashtags);
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

  async function handleApprove() {
    setApproving(true);
    setApprovalError("");
    try {
      const res = await fetch(`/api/v1/posts/${post.id}/approve`, { method: "POST" });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      setLocalStatus("APPROVED");
      setApprovedByUser(true);
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
      const res = await fetch(`/api/v1/companies/${slug}/buffer/profiles`);
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
          <Badge variant={channelMeta.variant}>{channelMeta.label}</Badge>
          <StatusBadge status={localStatus.toLowerCase() as PostStatusValue} />
        </div>
        <span className="text-fg-faint text-xs">{formatDate(post.createdAt)}</span>
      </div>

      {/* Post text */}
      <p className="text-fg mb-4 flex-1 text-sm leading-relaxed whitespace-pre-line">{localText}</p>

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

      {/* Published info */}
      {publishedAt && (
        <div className="rounded-control bg-status-success-bg mb-3 border border-green-100 px-4 py-3">
          <p className="text-status-success-fg text-xs font-semibold">
            {t("sentToBuffer", { date: formatDate(publishedAt) })}
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
      {isApproved && post.approvedById === null && !approvedByUser && (
        <Alert variant="info" role="status" className="mb-3">
          {t("autoApprovedInfo")}
        </Alert>
      )}

      {/* Publish panel */}
      {publishOpen && isApproved && (
        <div className="rounded-control border-status-info-dot/30 bg-status-info-bg mb-3 border px-4 py-3">
          <p className="text-status-info-fg mb-2 text-xs font-semibold">
            {t("publishPanel.title")}
          </p>
          {loadingProfiles ? (
            <p className="text-status-info-fg text-xs">{t("publishPanel.loadingProfiles")}</p>
          ) : profiles.length === 0 ? (
            <p className="text-status-info-fg text-xs">{t("publishPanel.noProfiles")}</p>
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

        {/* Submit for approval — draft only, any member */}
        {isDraft && (
          <Button
            variant="secondary"
            size="sm"
            loading={submitting}
            onClick={handleSubmitForApproval}
          >
            {submitting ? t("submitting") : t("submitForApproval")}
          </Button>
        )}

        {/* Approve / Reject — pending only, owner/admin */}
        {isPendingApproval && canApprove && (
          <>
            <Button variant="primary" size="sm" loading={approving} onClick={handleApprove}>
              {approving ? t("approving") : t("approve")}
            </Button>
            <Button variant="danger" size="sm" loading={rejecting} onClick={handleReject}>
              {rejecting ? t("rejecting") : t("reject")}
            </Button>
          </>
        )}

        {/* Publish to Buffer — approved only */}
        {canPublish && bufferConnected && isApproved && !publishOpen && (
          <Button variant="secondary" size="sm" onClick={handleOpenPublish}>
            {t("publishToBuffer")}
          </Button>
        )}
        {canPublish && !bufferConnected && isApproved && (
          <span className="text-fg-faint text-xs">{t("connectBufferToPublish")}</span>
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

        {/* Delete — draft only, owner/admin */}
        {canDelete &&
          isDraft &&
          (confirmDelete ? (
            <>
              <p className="text-fg-muted text-xs">{t("deleteDraft")}</p>
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

      {/* View Activity — always available */}
      <div className="border-border mt-3 border-t pt-3">
        <button
          onClick={() => setActivityOpen(true)}
          className="text-fg-faint hover:text-fg text-xs transition-colors"
        >
          {t("viewActivity")}
        </button>
      </div>

      {editOpen && (
        <EditPostModal
          postId={post.id}
          initialContent={localText}
          initialHashtags={localHashtags}
          canRestore={canApprove}
          onClose={() => setEditOpen(false)}
          onSaved={handlePostSaved}
        />
      )}

      {activityOpen && (
        <PostActivityModal
          postId={post.id}
          open={activityOpen}
          onClose={() => setActivityOpen(false)}
        />
      )}

      {pickerOpen && (
        <ImagePickerModal
          postId={post.id}
          companySlug={slug}
          postImagePrompt={post.imagePrompt ?? null}
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
