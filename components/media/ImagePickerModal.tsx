"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { IMAGE_STYLES, type ImageStyle } from "@/lib/ai/image/image-style";
import { formatDate } from "@/lib/i18n/format-date";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GalleryMediaItem {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  createdAt: string;
  provider: string;
}

type Tab = "gallery" | "ai" | "source" | "upload";

export interface AttachedMedia {
  id: string;
  url: string;
  /** Set only when the image came from the source article, so the caller can
   *  keep its "Use AI image" affordance in step with the picker. */
  origin?: "source_article";
  /** The asset this displaced — what switching back would restore. */
  previousMediaId?: string | null;
}

interface Props {
  postId: string;
  companySlug: string;
  postImagePrompt: string | null;
  /**
   * Whether this post was written from an RSS article at all. False for brand
   * setup, prompt, calendar-event and product-page posts — they have no original
   * article, so the tab is not offered.
   */
  hasArticleSource: boolean;
  /**
   * The article image already known to the caller, when it has one. Null means
   * "not known yet", not "none": the tab asks the server, which may still find
   * one on an item ingested before the column existed.
   */
  sourceImageUrl?: string | null;
  // Gallery state passed from parent (loaded in the click handler that opens the modal)
  galleryItems: GalleryMediaItem[];
  galleryLoading: boolean;
  galleryError: string;
  onGalleryRetry: () => void;
  onClose: () => void;
  onAttached: (media: AttachedMedia) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Tab bar ──────────────────────────────────────────────────────────────────

function TabBar({
  active,
  onChange,
  showSource,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
  showSource: boolean;
}) {
  const t = useTranslations("imagePicker");
  const tabs: { value: Tab; label: string }[] = [
    { value: "gallery", label: t("galleryTab") },
    { value: "ai", label: t("aiTab") },
    ...(showSource ? [{ value: "source" as const, label: t("sourceTab") }] : []),
    { value: "upload", label: t("uploadTab") },
  ];
  return (
    <div className="border-border -mx-6 mb-5 flex border-b px-6">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          className={[
            "mr-5 border-b-2 pb-3 text-sm font-medium transition-colors",
            active === tab.value
              ? "border-accent text-accent"
              : "text-fg-muted hover:text-fg border-transparent",
          ].join(" ")}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ─── Gallery Tab ──────────────────────────────────────────────────────────────

function GalleryTab({
  postId,
  items,
  loading,
  error,
  onRetry,
  onAttached,
}: {
  postId: string;
  items: GalleryMediaItem[];
  loading: boolean;
  error: string;
  onRetry: () => void;
  onAttached: (media: AttachedMedia) => void;
}) {
  const t = useTranslations("imagePicker");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const [attachingId, setAttachingId] = useState<string | null>(null);
  const [attachError, setAttachError] = useState("");
  const [search, setSearch] = useState("");

  async function handleSelect(item: GalleryMediaItem) {
    setAttachingId(item.id);
    setAttachError("");
    try {
      const res = await fetch(`/api/v1/posts/${postId}/attach-media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId: item.id }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      onAttached({ id: item.id, url: item.url });
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setAttachingId(null);
    }
  }

  const filtered = search
    ? items.filter(
        (i) =>
          i.provider.toLowerCase().includes(search.toLowerCase()) ||
          formatDate(i.createdAt).toLowerCase().includes(search.toLowerCase())
      )
    : items;

  if (loading) {
    return <p className="text-fg-faint py-12 text-center text-sm">{t("loadingGallery")}</p>;
  }

  if (error) {
    return (
      <div className="space-y-3">
        <Alert variant="error">{error}</Alert>
        <Button variant="ghost" size="sm" onClick={onRetry}>
          {tCommon("retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {attachError && <Alert variant="error">{attachError}</Alert>}

      <input
        type="text"
        placeholder={t("searchPlaceholder")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="rounded-control border-border-strong focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2 text-sm outline-none focus:ring-2"
      />

      {filtered.length === 0 ? (
        <p className="text-fg-faint py-8 text-center text-sm">
          {items.length === 0 ? t("noImages") : t("noResults")}
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {filtered.map((item) => (
            <div
              key={item.id}
              className="rounded-card border-border bg-surface-subtle overflow-hidden border"
            >
              <div className="bg-surface-subtle relative aspect-square w-full overflow-hidden">
                <Image
                  src={item.url}
                  alt={t("galleryImageAlt")}
                  fill
                  className="object-cover"
                  unoptimized
                  loading="lazy"
                />
              </div>
              <div className="px-2 pt-2 pb-1">
                <p className="text-fg-faint truncate text-xs">{formatDate(item.createdAt)}</p>
                <p className="text-fg-muted truncate text-xs font-medium">{item.provider}</p>
              </div>
              <div className="px-2 pb-2">
                <Button
                  variant="primary"
                  size="sm"
                  loading={attachingId === item.id}
                  disabled={attachingId !== null}
                  onClick={() => void handleSelect(item)}
                  className="w-full"
                >
                  {attachingId === item.id ? tCommon("attaching") : tCommon("attach")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── AI Generate Tab ──────────────────────────────────────────────────────────

function AiGenerateTab({
  postId,
  postImagePrompt,
  onAttached,
}: {
  postId: string;
  postImagePrompt: string | null;
  onAttached: (media: AttachedMedia) => void;
}) {
  const t = useTranslations("imagePicker");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<AttachedMedia | null>(null);
  const [imageStyle, setImageStyle] = useState<ImageStyle>("default");
  const [prompt, setPrompt] = useState(postImagePrompt ?? "");

  const trimmedPrompt = prompt.trim();
  const canGenerate = trimmedPrompt.length > 0;
  const isEdited = postImagePrompt != null && prompt !== postImagePrompt;

  async function handleGenerate() {
    if (!canGenerate) return;
    setGenerating(true);
    setError("");
    setPreview(null);
    try {
      const res = await fetch(`/api/v1/posts/${postId}/generate-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageStyle, imagePrompt: trimmedPrompt }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { media: { id: string; url: string } };
      setPreview(json.media);
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <label
            htmlFor="image-prompt"
            className="text-fg-faint block text-xs font-semibold tracking-wide uppercase"
          >
            {t("imagePrompt")}
          </label>
          {isEdited && (
            <button
              type="button"
              onClick={() => setPrompt(postImagePrompt ?? "")}
              disabled={generating}
              className="text-accent text-xs font-medium hover:underline disabled:opacity-50"
            >
              {t("resetPrompt")}
            </button>
          )}
        </div>
        <textarea
          id="image-prompt"
          value={prompt}
          disabled={generating}
          rows={3}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("imagePromptPlaceholder")}
          className="rounded-control border-border-strong focus:border-accent focus:ring-accent/20 w-full resize-y border px-3.5 py-2 text-sm leading-relaxed outline-none focus:ring-2"
        />
        <p className="text-fg-faint mt-1 text-xs">{t("imagePromptHint")}</p>
      </div>

      <div>
        <label
          htmlFor="image-style"
          className="text-fg-faint mb-1 block text-xs font-semibold tracking-wide uppercase"
        >
          {t("imageStyleLabel")}
        </label>
        <select
          id="image-style"
          value={imageStyle}
          disabled={generating}
          onChange={(e) => setImageStyle(e.target.value as ImageStyle)}
          className="rounded-control border-border-strong focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2 text-sm outline-none focus:ring-2"
        >
          {IMAGE_STYLES.map((style) => (
            <option key={style} value={style}>
              {t(`imageStyleOption.${style}`)}
            </option>
          ))}
        </select>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {preview ? (
        <div className="space-y-3">
          <div className="rounded-card border-border overflow-hidden border">
            <Image
              src={preview.url}
              alt={t("generatedPreviewAlt")}
              width={800}
              height={450}
              className="w-full object-cover"
              unoptimized
            />
          </div>
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={() => onAttached(preview)}>
              {t("attachThis")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={generating}
              disabled={!canGenerate}
              onClick={() => void handleGenerate()}
            >
              {generating ? t("generating") : t("regenerate")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="primary"
          size="sm"
          loading={generating}
          disabled={!canGenerate}
          onClick={() => void handleGenerate()}
        >
          {generating ? t("generatingImage") : t("generateImage")}
        </Button>
      )}
    </div>
  );
}

// ─── Source Article Tab ───────────────────────────────────────────────────────

/**
 * The image the original article uses, offered as an alternative to the AI one.
 *
 * The address is resolved on open rather than assumed: items ingested before the
 * column existed carry no stored image, and the server scrapes the article once
 * to fill the gap. Picking it downloads the file server-side and pushes it
 * through the same Cloudinary/MediaAsset pipeline as an upload — the post never
 * hotlinks a publisher's CDN, and the AI image it replaces is kept.
 */
function SourceArticleTab({
  postId,
  knownImageUrl,
  onAttached,
}: {
  postId: string;
  knownImageUrl: string | null;
  onAttached: (media: AttachedMedia) => void;
}) {
  const t = useTranslations("imagePicker");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const [imageUrl, setImageUrl] = useState<string | null>(knownImageUrl);
  const [resolving, setResolving] = useState(knownImageUrl === null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  // A URL that will not render is no use to the user even if the server accepted
  // it — treated exactly like having found nothing.
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (knownImageUrl !== null) return;
    let cancelled = false;
    // `resolving` already starts true in exactly this case — setting it here
    // would only add a cascading render.
    fetch(`/api/v1/posts/${postId}/source-image`)
      .then(async (res) => {
        const json = (await res.json()) as {
          sourceImageUrl?: string | null;
          error?: { message?: string };
        };
        if (cancelled) return;
        if (!res.ok) throw new Error(apiError(json.error));
        setImageUrl(json.sourceImageUrl ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleUse() {
    setApplying(true);
    setError("");
    try {
      const res = await fetch(`/api/v1/posts/${postId}/use-source-image`, { method: "POST" });
      const json = (await res.json()) as {
        media?: { id: string; url: string };
        previousMediaId?: string | null;
        error?: { message?: string };
      };
      if (!res.ok || !json.media) throw new Error(apiError(json.error));
      onAttached({
        ...json.media,
        origin: "source_article",
        previousMediaId: json.previousMediaId ?? null,
      });
    } catch (err) {
      // Nothing was written server-side on a failed download or upload, so the
      // post still has exactly the image it had when the modal opened.
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setApplying(false);
    }
  }

  if (resolving) {
    return <p className="text-fg-faint py-12 text-center text-sm">{t("sourceResolving")}</p>;
  }

  if (!imageUrl || broken) {
    return (
      <div className="space-y-3">
        {error && <Alert variant="error">{error}</Alert>}
        <p className="text-fg-faint py-8 text-center text-sm">{t("sourceNoImage")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && <Alert variant="error">{error}</Alert>}

      <p className="text-fg-muted text-xs leading-relaxed">{t("sourceHint")}</p>

      <div className="rounded-card border-border bg-surface-subtle overflow-hidden border">
        <Image
          src={imageUrl}
          alt={t("sourcePreviewAlt")}
          width={800}
          height={450}
          className="w-full object-cover"
          unoptimized
          onError={() => setBroken(true)}
        />
      </div>

      <Button variant="primary" size="sm" loading={applying} onClick={() => void handleUse()}>
        {applying ? t("sourceUsing") : t("sourceUse")}
      </Button>
    </div>
  );
}

// ─── Upload Tab ───────────────────────────────────────────────────────────────

function UploadTab({
  companySlug,
  postId,
  onAttached,
}: {
  companySlug: string;
  postId: string;
  onAttached: (media: AttachedMedia) => void;
}) {
  const t = useTranslations("imagePicker");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function selectFile(f: File) {
    setError("");
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) selectFile(f);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) selectFile(f);
  }

  async function handleAttach() {
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("slug", companySlug);

      const uploadRes = await fetch("/api/v1/media/upload", { method: "POST", body: form });
      if (!uploadRes.ok) {
        const json = (await uploadRes.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const { media } = (await uploadRes.json()) as { media: { id: string; url: string } };

      const attachRes = await fetch(`/api/v1/posts/${postId}/attach-media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId: media.id }),
      });
      if (!attachRes.ok) {
        const json = (await attachRes.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }

      onAttached(media);
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert variant="error">{error}</Alert>}

      {!file ? (
        <div
          onDrop={handleDrop}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
          className={[
            "rounded-card flex cursor-pointer flex-col items-center justify-center gap-3 border-2 border-dashed px-6 py-12 transition-colors",
            dragging
              ? "border-status-success-dot bg-status-success-bg"
              : "border-border-strong bg-surface-subtle hover:border-status-success-dot hover:bg-status-success-bg",
          ].join(" ")}
        >
          <svg
            className="text-fg-faint h-10 w-10"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          <div className="text-center">
            <p className="text-fg-muted text-sm font-medium">{t("dropzone")}</p>
            <p className="text-fg-faint mt-1 text-xs">{t("dropzoneHint")}</p>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/webp"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {previewUrl && (
            <div className="rounded-card border-border overflow-hidden border">
              {/* next/image cannot be used with blob: URLs — <img> is intentional for local preview */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt={t("uploadPreviewAlt")} className="w-full object-cover" />
            </div>
          )}
          <p className="text-fg-muted text-xs">
            {file.name} &mdash; {(file.size / 1024 / 1024).toFixed(2)} MB
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={uploading}
              onClick={() => void handleAttach()}
            >
              {uploading ? t("uploading") : t("uploadAttach")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={uploading}
              onClick={() => {
                setFile(null);
                setPreviewUrl(null);
                setError("");
              }}
            >
              {t("chooseDifferent")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export function ImagePickerModal({
  postId,
  companySlug,
  postImagePrompt,
  hasArticleSource,
  sourceImageUrl = null,
  galleryItems,
  galleryLoading,
  galleryError,
  onGalleryRetry,
  onClose,
  onAttached,
}: Props) {
  const t = useTranslations("imagePicker");
  const [tab, setTab] = useState<Tab>("gallery");

  function handleAttached(media: AttachedMedia) {
    onAttached(media);
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={t("title")} maxWidth="xl">
      <TabBar active={tab} onChange={setTab} showSource={hasArticleSource} />

      {tab === "gallery" && (
        <GalleryTab
          postId={postId}
          items={galleryItems}
          loading={galleryLoading}
          error={galleryError}
          onRetry={onGalleryRetry}
          onAttached={handleAttached}
        />
      )}
      {tab === "ai" && (
        <AiGenerateTab
          postId={postId}
          postImagePrompt={postImagePrompt}
          onAttached={handleAttached}
        />
      )}
      {tab === "source" && hasArticleSource && (
        <SourceArticleTab
          postId={postId}
          knownImageUrl={sourceImageUrl}
          onAttached={handleAttached}
        />
      )}
      {tab === "upload" && (
        <UploadTab companySlug={companySlug} postId={postId} onAttached={handleAttached} />
      )}
    </Modal>
  );
}
