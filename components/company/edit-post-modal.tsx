"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function EditPostModal({
  postId,
  initialContent,
  initialHashtags,
  canRestore,
  onClose,
  onSaved,
}: Props) {
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
        throw new Error(json.error?.message ?? "Failed to load history.");
      }
      const json = (await res.json()) as { versions: PostVersionItem[] };
      setVersions(json.versions);
    } catch (err) {
      setVersionsError(err instanceof Error ? err.message : "Failed to load history.");
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
        throw new Error(json.error?.message ?? "Failed to save changes.");
      }
      onSaved(text, hashtags);
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Something went wrong.");
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
        throw new Error(json.error?.message ?? "Failed to restore version.");
      }
      onSaved(versionContent, initialHashtags);
      onClose();
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <Modal open onClose={onClose} title="Edit Post" maxWidth="lg">
      {/* Tabs */}
      <div className="-mx-6 mb-5 flex border-b border-gray-100 px-6">
        {(["edit", "history"] as const).map((t) => (
          <button
            key={t}
            onClick={() => handleTabChange(t)}
            className={[
              "mr-4 border-b-2 pb-3 text-sm font-medium transition-colors",
              tab === t
                ? "border-green-500 text-green-700"
                : "border-transparent text-gray-500 hover:text-gray-800",
            ].join(" ")}
          >
            {t === "edit" ? "Edit" : "Version History"}
          </button>
        ))}
      </div>

      {/* Edit tab */}
      {tab === "edit" && (
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Content</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              disabled={saving}
              className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm leading-relaxed transition-colors outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:opacity-50"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
              Hashtags <span className="font-normal text-gray-400">(space or comma separated)</span>
            </label>
            <input
              type="text"
              value={hashtagsRaw}
              onChange={(e) => setHashtagsRaw(e.target.value)}
              placeholder="#marketing #growth"
              disabled={saving}
              className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm transition-colors outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 disabled:opacity-50"
            />
          </div>

          {saveError && <Alert variant="error">{saveError}</Alert>}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>
              {saving ? "Saving…" : "Save Changes"}
            </Button>
          </div>
        </div>
      )}

      {/* History tab */}
      {tab === "history" && (
        <div>
          {loadingVersions ? (
            <p className="py-8 text-center text-sm text-gray-400">Loading history…</p>
          ) : versionsError ? (
            <Alert variant="error">{versionsError}</Alert>
          ) : versions.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">
              No version history yet. Versions are saved each time you edit the post.
            </p>
          ) : (
            <div className="space-y-3">
              {restoreError && <Alert variant="error">{restoreError}</Alert>}
              {versions.map((v) => (
                <div
                  key={v.id}
                  className="flex items-start justify-between gap-4 rounded-lg border border-gray-100 bg-gray-50 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-semibold text-gray-700">v{v.version}</span>
                      <span className="text-xs text-gray-300">·</span>
                      <span className="text-xs text-gray-400">{formatDate(v.createdAt)}</span>
                      {v.changedByName && (
                        <>
                          <span className="text-xs text-gray-300">·</span>
                          <span className="text-xs text-gray-500">{v.changedByName}</span>
                        </>
                      )}
                    </div>
                    <p className="text-xs leading-relaxed text-gray-600">
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
                      Restore
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
