"use client";

import { useState, useRef } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GalleryMediaItem {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  createdAt: string;
  provider: string;
}

type Tab = "gallery" | "ai" | "upload";

interface AttachedMedia {
  id: string;
  url: string;
}

interface Props {
  postId: string;
  companySlug: string;
  postImagePrompt: string | null;
  // Gallery state passed from parent (loaded in the click handler that opens the modal)
  galleryItems: GalleryMediaItem[];
  galleryLoading: boolean;
  galleryError: string;
  onGalleryRetry: () => void;
  onClose: () => void;
  onAttached: (media: AttachedMedia) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Tab bar ──────────────────────────────────────────────────────────────────

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const t = useTranslations("imagePicker");
  const tabs: { value: Tab; label: string }[] = [
    { value: "gallery", label: t("galleryTab") },
    { value: "ai", label: t("aiTab") },
    { value: "upload", label: t("uploadTab") },
  ];
  return (
    <div className="-mx-6 mb-5 flex border-b border-gray-100 px-6">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          className={[
            "mr-5 border-b-2 pb-3 text-sm font-medium transition-colors",
            active === tab.value
              ? "border-green-500 text-green-700"
              : "border-transparent text-gray-500 hover:text-gray-800",
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
    return <p className="py-12 text-center text-sm text-gray-400">{t("loadingGallery")}</p>;
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
        className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
      />

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-400">
          {items.length === 0 ? t("noImages") : t("noResults")}
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {filtered.map((item) => (
            <div
              key={item.id}
              className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50"
            >
              <div className="relative aspect-square w-full overflow-hidden bg-gray-100">
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
                <p className="truncate text-xs text-gray-400">{formatDate(item.createdAt)}</p>
                <p className="truncate text-xs font-medium text-gray-600">{item.provider}</p>
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

  async function handleGenerate() {
    setGenerating(true);
    setError("");
    setPreview(null);
    try {
      const res = await fetch(`/api/v1/posts/${postId}/generate-image`, { method: "POST" });
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
      {!postImagePrompt ? (
        <Alert variant="warning">{t("noPrompt")}</Alert>
      ) : (
        <div className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
          <p className="mb-1 text-xs font-semibold tracking-wide text-gray-400 uppercase">
            {t("imagePrompt")}
          </p>
          <p className="text-sm leading-relaxed text-gray-700">{postImagePrompt}</p>
        </div>
      )}

      {error && <Alert variant="error">{error}</Alert>}

      {preview ? (
        <div className="space-y-3">
          <div className="overflow-hidden rounded-xl border border-gray-200">
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
              disabled={!postImagePrompt}
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
          disabled={!postImagePrompt}
          onClick={() => void handleGenerate()}
        >
          {generating ? t("generatingImage") : t("generateImage")}
        </Button>
      )}
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
            "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 transition-colors",
            dragging
              ? "border-green-400 bg-green-50"
              : "border-gray-300 bg-gray-50 hover:border-green-400 hover:bg-green-50",
          ].join(" ")}
        >
          <svg
            className="h-10 w-10 text-gray-400"
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
            <p className="text-sm font-medium text-gray-700">{t("dropzone")}</p>
            <p className="mt-1 text-xs text-gray-400">{t("dropzoneHint")}</p>
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
            <div className="overflow-hidden rounded-xl border border-gray-200">
              {/* next/image cannot be used with blob: URLs — <img> is intentional for local preview */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt={t("uploadPreviewAlt")} className="w-full object-cover" />
            </div>
          )}
          <p className="text-xs text-gray-500">
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
      <TabBar active={tab} onChange={setTab} />

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
      {tab === "upload" && (
        <UploadTab companySlug={companySlug} postId={postId} onAttached={handleAttached} />
      )}
    </Modal>
  );
}
