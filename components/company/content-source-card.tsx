"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ContentSourceForm } from "./content-source-form";
import type { ContentSourceItem } from "@/lib/services/company/list-content-sources.service";
import type { ContentSourcePayload } from "./content-source-form";

interface Props {
  slug: string;
  source: ContentSourceItem;
  canManage: boolean;
  onDelete: (id: string) => void;
  onUpdate: (source: ContentSourceItem) => void;
}

function formatDate(iso: string | null, never: string): string {
  if (!iso) return never;
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sourcePreview(source: ContentSourceItem): string {
  const c = source.config;
  if (source.type === "rss" || source.type === "product_page") return c.url ?? "";
  if (source.type === "prompt") {
    const text = c.promptText ?? "";
    return text.length > 80 ? text.slice(0, 80) + "…" : text;
  }
  if (source.type === "calendar_event") return `${c.title ?? ""} · ${c.date ?? ""}`;
  return "";
}

export function ContentSourceCard({ slug, source, canManage, onDelete, onUpdate }: Props) {
  const t = useTranslations("contentSources");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");

  const [ingesting, setIngesting] = useState(false);
  const [ingestResult, setIngestResult] = useState<{ created: number; updated: number } | null>(
    null
  );
  const [ingestError, setIngestError] = useState("");

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const TYPE_META: Record<
    string,
    { label: string; variant: "warning" | "neutral" | "success" | "editor" }
  > = {
    rss: { label: t("rss"), variant: "warning" },
    prompt: { label: t("prompt"), variant: "neutral" },
    product_page: { label: t("productPage"), variant: "success" },
    calendar_event: { label: t("calendar"), variant: "editor" },
  };

  const meta = TYPE_META[source.type] ?? { label: source.type, variant: "neutral" as const };

  async function handleSave(data: ContentSourcePayload) {
    setSaving(true);
    setEditError("");
    try {
      const res = await fetch(`/api/v1/companies/${slug}/content-sources/${source.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { source: ContentSourceItem };
      onUpdate(json.source);
      setIsEditing(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setSaving(false);
    }
  }

  async function handleIngest() {
    setIngesting(true);
    setIngestResult(null);
    setIngestError("");
    try {
      const res = await fetch(`/api/v1/companies/${slug}/content-sources/${source.id}/ingest`, {
        method: "POST",
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { created: number; updated: number };
      setIngestResult(json);
    } catch (err) {
      setIngestError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setIngesting(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/v1/companies/${slug}/content-sources/${source.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      onDelete(source.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <Card className="px-5 py-5">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge variant={meta.variant}>{meta.label}</Badge>
            <Badge variant={source.enabled ? "success" : "neutral"}>
              {source.enabled ? t("active") : t("inactive")}
            </Badge>
          </div>
          <h3 className="text-fg truncate text-sm font-semibold">{source.name}</h3>
        </div>
      </div>

      {/* Preview */}
      <p className="text-fg-faint mb-3 truncate text-xs">{sourcePreview(source)}</p>

      {/* Last fetched */}
      <p className="text-fg-faint mb-4 text-xs">
        {t("lastIngested")}{" "}
        <span className="text-fg-muted">{formatDate(source.lastFetchedAt, t("never"))}</span>
      </p>

      {/* Alerts */}
      {ingestResult && (
        <Alert variant="success" className="mb-3">
          {t("ingestSuccess", { created: ingestResult.created, updated: ingestResult.updated })}
        </Alert>
      )}
      {ingestError && (
        <Alert variant="error" className="mb-3">
          {ingestError}
        </Alert>
      )}
      {deleteError && (
        <Alert variant="error" className="mb-3">
          {deleteError}
        </Alert>
      )}

      {/* Edit form */}
      {isEditing ? (
        <>
          {editError && (
            <Alert variant="error" className="mb-3">
              {editError}
            </Alert>
          )}
          <ContentSourceForm
            initialData={source}
            saving={saving}
            onSave={handleSave}
            onCancel={() => {
              setIsEditing(false);
              setEditError("");
            }}
          />
        </>
      ) : canManage ? (
        <>
          {/* Delete confirmation */}
          {confirmDelete ? (
            <div className="flex items-center gap-3">
              <p className="text-fg-muted text-xs">{t("deleteSource")}</p>
              <Button variant="danger" size="sm" loading={deleting} onClick={handleDelete}>
                {deleting ? tCommon("deleting") : tCommon("confirm")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                {tCommon("cancel")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" loading={ingesting} onClick={handleIngest}>
                {ingesting ? t("ingesting") : t("ingest")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setIsEditing(true)}>
                {tCommon("edit")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setConfirmDelete(true);
                  setIngestResult(null);
                }}
              >
                {tCommon("delete")}
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="text-fg-faint text-xs">{t("ownersOnly")}</p>
      )}
    </Card>
  );
}
