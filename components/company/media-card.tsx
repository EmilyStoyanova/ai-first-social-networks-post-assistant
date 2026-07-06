"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Modal } from "@/components/ui/Modal";
import type { MediaItem } from "@/lib/services/company/list-media.service";
import type { PostItem } from "@/lib/services/company/list-posts.service";

type BadgeVariant =
  "owner" | "editor" | "comingSoon" | "success" | "warning" | "danger" | "neutral" | "readonly";

const CHANNEL_META: Record<string, { label: string; variant: BadgeVariant }> = {
  FACEBOOK: { label: "Facebook", variant: "neutral" },
  LINKEDIN: { label: "LinkedIn", variant: "editor" },
  INSTAGRAM: { label: "Instagram", variant: "warning" },
  TIKTOK: { label: "TikTok", variant: "danger" },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface Props {
  item: MediaItem;
  slug: string;
  canDelete?: boolean;
  onDeleted?: (id: string) => void;
}

export function MediaCard({ item, slug, canDelete = false, onDeleted }: Props) {
  const t = useTranslations("mediaCard");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();

  const [reuseOpen, setReuseOpen] = useState(false);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [draftPosts, setDraftPosts] = useState<PostItem[]>([]);
  const [selectedPostId, setSelectedPostId] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState("");
  const [attachedSuccess, setAttachedSuccess] = useState(false);

  // Preview modal
  const [previewOpen, setPreviewOpen] = useState(false);

  // Delete
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const channelMeta = item.post
    ? (CHANNEL_META[item.post.channel] ?? {
        label: item.post.channel,
        variant: "neutral" as BadgeVariant,
      })
    : null;

  async function handleOpenReuse() {
    setReuseOpen(true);
    setAttachError("");
    setAttachedSuccess(false);
    setLoadingPosts(true);
    try {
      const res = await fetch(`/api/v1/companies/${slug}/posts`);
      const json = (await res.json()) as { posts: PostItem[] };
      const drafts = json.posts.filter((p) => p.status === "DRAFT");
      setDraftPosts(drafts);
      setSelectedPostId(drafts[0]?.id ?? "");
    } catch {
      setAttachError(tCommon("somethingWentWrong"));
    } finally {
      setLoadingPosts(false);
    }
  }

  async function handleAttach() {
    if (!selectedPostId) return;
    setAttaching(true);
    setAttachError("");
    try {
      const res = await fetch(`/api/v1/posts/${selectedPostId}/attach-media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId: item.id }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      setAttachedSuccess(true);
      setReuseOpen(false);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setAttaching(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/v1/companies/${slug}/media/${item.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      onDeleted?.(item.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <>
      <div className="rounded-card border-border bg-surface flex flex-col overflow-hidden border shadow-sm">
        {/* Image — clickable for preview */}
        <button
          type="button"
          className="bg-surface-subtle relative aspect-video w-full overflow-hidden"
          onClick={() => setPreviewOpen(true)}
          aria-label={t("preview")}
        >
          <Image
            src={item.url}
            alt={item.post ? t("imageForPost", { channel: item.post.channel }) : t("mediaAsset")}
            fill
            className="duration-fast object-cover transition-transform hover:scale-105"
            unoptimized
            loading="lazy"
          />
          <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity hover:opacity-100">
            <div className="rounded-full bg-black/40 px-3 py-1.5">
              <span className="text-xs font-medium text-white">{t("preview")}</span>
            </div>
          </div>
        </button>

        {/* Content */}
        <div className="flex flex-1 flex-col px-4 py-4">
          {/* Badges row */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {channelMeta && <Badge variant={channelMeta.variant}>{channelMeta.label}</Badge>}
            <Badge variant="neutral">{item.provider}</Badge>
          </div>

          {/* Metadata */}
          <dl className="text-fg-muted mb-4 space-y-1 text-xs">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-fg-faint font-medium">{t("created")}</dt>
              <dd>{formatDate(item.createdAt)}</dd>
            </div>
            {item.width && item.height && (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-fg-faint font-medium">{t("dimensions")}</dt>
                <dd>
                  {item.width} × {item.height}
                </dd>
              </div>
            )}
            {item.post && (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-fg-faint font-medium">{t("status")}</dt>
                <dd>{item.post.status}</dd>
              </div>
            )}
          </dl>

          {/* Success banner */}
          {attachedSuccess && (
            <Alert variant="success" className="mb-3">
              {t("attachedSuccess")}
            </Alert>
          )}

          {/* Delete error */}
          {deleteError && (
            <Alert variant="error" className="mb-3">
              {deleteError}
            </Alert>
          )}

          {/* Reuse panel */}
          {reuseOpen && (
            <div className="rounded-control border-border bg-surface-subtle mb-3 border px-3 py-3">
              <p className="text-fg-muted mb-2 text-xs font-semibold">{t("attachToDraft")}</p>
              {loadingPosts ? (
                <p className="text-fg-faint text-xs">{t("loadingPosts")}</p>
              ) : draftPosts.length === 0 ? (
                <p className="text-fg-faint text-xs">{t("noDrafts")}</p>
              ) : (
                <select
                  value={selectedPostId}
                  onChange={(e) => setSelectedPostId(e.target.value)}
                  disabled={attaching}
                  className="rounded-control border-border-strong bg-surface focus:border-accent focus:ring-accent/20 mb-2 w-full border px-3 py-2 text-xs outline-none focus:ring-2"
                >
                  {draftPosts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.channel} — {p.text.slice(0, 50)}
                      {p.text.length > 50 ? "…" : ""}
                    </option>
                  ))}
                </select>
              )}
              {attachError && (
                <Alert variant="error" className="mb-2">
                  {attachError}
                </Alert>
              )}
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  loading={attaching}
                  disabled={!selectedPostId || loadingPosts}
                  onClick={() => void handleAttach()}
                >
                  {attaching ? tCommon("attaching") : tCommon("attach")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setReuseOpen(false);
                    setAttachError("");
                  }}
                >
                  {tCommon("cancel")}
                </Button>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="mt-auto flex flex-wrap items-center gap-2">
            {item.post && (
              <Link
                href={`/companies/${slug}`}
                className="rounded-control text-fg-muted hover:bg-surface-subtle inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold transition-colors"
              >
                {t("openPost")}
              </Link>
            )}

            {!reuseOpen && (
              <Button variant="ghost" size="sm" onClick={() => void handleOpenReuse()}>
                {t("reuseImage")}
              </Button>
            )}

            {/* Copy URL */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void navigator.clipboard.writeText(item.url)}
            >
              {t("copyUrl")}
            </Button>

            {/* Delete — owners only */}
            {canDelete &&
              (confirmDelete ? (
                <>
                  <p className="text-fg-muted text-xs">{t("deleteImage")}</p>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={deleting}
                    onClick={() => void handleDelete()}
                  >
                    {deleting ? tCommon("deleting") : tCommon("confirm")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setConfirmDelete(false);
                      setDeleteError("");
                    }}
                  >
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
        </div>
      </div>

      {/* Preview modal */}
      {previewOpen && (
        <Modal open onClose={() => setPreviewOpen(false)} title={t("imagePreview")} maxWidth="xl">
          <div className="space-y-4">
            <div className="rounded-card border-border overflow-hidden border">
              <Image
                src={item.url}
                alt={t("imagePreview")}
                width={item.width ?? 1200}
                height={item.height ?? 630}
                className="w-full object-contain"
                unoptimized
              />
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
              {item.width && item.height && (
                <>
                  <dt className="text-fg-faint font-medium">{t("dimensions")}</dt>
                  <dd className="text-fg-muted">
                    {item.width} × {item.height}
                  </dd>
                </>
              )}
              <dt className="text-fg-faint font-medium">{t("status")}</dt>
              <dd className="text-fg-muted">{item.provider}</dd>
              <dt className="text-fg-faint font-medium">{t("created")}</dt>
              <dd className="text-fg-muted">{formatDate(item.createdAt)}</dd>
            </dl>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void navigator.clipboard.writeText(item.url)}
              >
                {t("copyUrl")}
              </Button>
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-control border-border-strong text-fg-muted hover:bg-surface-subtle inline-flex items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold transition-colors"
              >
                {t("openInNewTab")}
              </a>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
