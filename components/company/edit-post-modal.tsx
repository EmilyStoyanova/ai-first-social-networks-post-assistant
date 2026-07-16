"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { formatDateTime } from "@/lib/i18n/format-date";

interface PostVersionItem {
  id: string;
  version: number;
  content: string;
  changedBy: string;
  changedByName: string | null;
  createdAt: string;
}

type Tab = "edit" | "history";

interface Props {
  postId: string;
  initialContent: string;
  initialHashtags: string[];
  canRestore: boolean;
  onClose: () => void;
  onSaved: (newContent: string, newHashtags: string[]) => void;
}

export function EditPostModal({
  postId,
  initialContent,
  initialHashtags,
  canRestore,
  onClose,
  onSaved,
}: Props) {
  const t = useTranslations("editPost");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const [tab, setTab] = useState<Tab>("edit");

  // Edit form
  const [text, setText] = useState(initialContent);
  const [hashtagsRaw, setHashtagsRaw] = useState(initialHashtags.join(" "));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // History
  const [versions, setVersions] = useState<PostVersionItem[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [versionsError, setVersionsError] = useState("");
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState("");

  async function loadVersions() {
    setLoadingVersions(true);
    setVersionsError("");
    try {
      const res = await fetch(`/api/v1/posts/${postId}/versions`);
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { versions: PostVersionItem[] };
      setVersions(json.versions);
    } catch (err) {
      setVersionsError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setLoadingVersions(false);
    }
  }

  function handleTabChange(next: Tab) {
    setTab(next);
    if (next === "history" && versions.length === 0 && !loadingVersions) {
      void loadVersions();
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveError("");
    try {
      const hashtags = hashtagsRaw
        .split(/[\s,]+/)
        .map((h) => h.replace(/^#/, "").trim())
        .filter(Boolean);

      const res = await fetch(`/api/v1/posts/${postId}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, hashtags }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      onSaved(text, hashtags);
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setSaving(false);
    }
  }

  async function handleRestore(versionId: string, versionContent: string) {
    setRestoringId(versionId);
    setRestoreError("");
    try {
      const res = await fetch(`/api/v1/posts/${postId}/restore/${versionId}`, { method: "POST" });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      onSaved(versionContent, initialHashtags);
      onClose();
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <Modal open onClose={onClose} title={t("title")} maxWidth="lg">
      {/* Tabs */}
      <div className="border-border -mx-6 mb-5 flex border-b px-6">
        {(["edit", "history"] as const).map((tabKey) => (
          <button
            key={tabKey}
            onClick={() => handleTabChange(tabKey)}
            className={[
              "mr-4 border-b-2 pb-3 text-sm font-medium transition-colors",
              tab === tabKey
                ? "border-status-success-dot text-status-success-fg"
                : "text-fg-muted hover:text-fg border-transparent",
            ].join(" ")}
          >
            {tabKey === "edit" ? t("tabEdit") : t("tabHistory")}
          </button>
        ))}
      </div>

      {/* Edit tab */}
      {tab === "edit" && (
        <div className="space-y-4">
          <div>
            <label className="text-fg-muted mb-1.5 block text-sm font-medium">
              {t("contentLabel")}
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              disabled={saving}
              className="rounded-control border-border-strong focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2.5 text-sm leading-relaxed transition-colors outline-none focus:ring-2 disabled:opacity-50"
            />
          </div>
          <div>
            <label className="text-fg-muted mb-1.5 block text-sm font-medium">
              {t("hashtagsLabel")}{" "}
              <span className="text-fg-faint font-normal">{t("hashtagsHint")}</span>
            </label>
            <input
              type="text"
              value={hashtagsRaw}
              onChange={(e) => setHashtagsRaw(e.target.value)}
              placeholder={t("hashtagsPlaceholder")}
              disabled={saving}
              className="rounded-control border-border-strong focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2.5 text-sm transition-colors outline-none focus:ring-2 disabled:opacity-50"
            />
          </div>

          {saveError && <Alert variant="error">{saveError}</Alert>}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              {tCommon("cancel")}
            </Button>
            <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>
              {saving ? t("saving") : t("saveChanges")}
            </Button>
          </div>
        </div>
      )}

      {/* History tab */}
      {tab === "history" && (
        <div>
          {loadingVersions ? (
            <p className="text-fg-faint py-8 text-center text-sm">{t("loadingHistory")}</p>
          ) : versionsError ? (
            <Alert variant="error">{versionsError}</Alert>
          ) : versions.length === 0 ? (
            <p className="text-fg-faint py-8 text-center text-sm">{t("noHistory")}</p>
          ) : (
            <div className="space-y-3">
              {restoreError && <Alert variant="error">{restoreError}</Alert>}
              {versions.map((v) => (
                <div
                  key={v.id}
                  className="rounded-control border-border bg-surface-subtle flex items-start justify-between gap-4 border px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                      <span className="text-fg-muted text-xs font-semibold">v{v.version}</span>
                      <span className="text-fg-faint text-xs">·</span>
                      <span className="text-fg-faint text-xs">{formatDateTime(v.createdAt)}</span>
                      {v.changedByName && (
                        <>
                          <span className="text-fg-faint text-xs">·</span>
                          <span className="text-fg-muted text-xs">{v.changedByName}</span>
                        </>
                      )}
                    </div>
                    <p className="text-fg-muted text-xs leading-relaxed">
                      {v.content.length > 120 ? v.content.slice(0, 120) + "…" : v.content}
                    </p>
                  </div>
                  {canRestore && (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={restoringId === v.id}
                      disabled={restoringId !== null}
                      onClick={() => handleRestore(v.id, v.content)}
                    >
                      {restoringId === v.id ? t("restoring") : t("restore")}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
