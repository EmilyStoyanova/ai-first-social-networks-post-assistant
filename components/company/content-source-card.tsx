import { useState } from "react";
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

const TYPE_META: Record<
  string,
  { label: string; variant: "warning" | "neutral" | "success" | "editor" }
> = {
  rss: { label: "RSS", variant: "warning" },
  prompt: { label: "Prompt", variant: "neutral" },
  product_page: { label: "Product Page", variant: "success" },
  calendar_event: { label: "Calendar", variant: "editor" },
};

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
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
        throw new Error(json.error?.message ?? "Failed to save.");
      }
      const json = (await res.json()) as { source: ContentSourceItem };
      onUpdate(json.source);
      setIsEditing(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Something went wrong.");
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
        throw new Error(json.error?.message ?? "Ingestion failed.");
      }
      const json = (await res.json()) as { created: number; updated: number };
      setIngestResult(json);
    } catch (err) {
      setIngestError(err instanceof Error ? err.message : "Something went wrong.");
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
        throw new Error(json.error?.message ?? "Failed to delete.");
      }
      onDelete(source.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Something went wrong.");
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
              {source.enabled ? "Active" : "Inactive"}
            </Badge>
          </div>
          <h3 className="truncate text-sm font-semibold text-gray-900">{source.name}</h3>
        </div>
      </div>

      {/* Preview */}
      <p className="mb-3 truncate text-xs text-gray-400">{sourcePreview(source)}</p>

      {/* Last fetched */}
      <p className="mb-4 text-xs text-gray-400">
        Last ingested: <span className="text-gray-600">{formatDate(source.lastFetchedAt)}</span>
      </p>

      {/* Alerts */}
      {ingestResult && (
        <Alert variant="success" className="mb-3">
          Ingested successfully — {ingestResult.created} created, {ingestResult.updated} updated.
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
              <p className="text-xs text-gray-500">Delete this source?</p>
              <Button variant="danger" size="sm" loading={deleting} onClick={handleDelete}>
                {deleting ? "Deleting…" : "Confirm"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" loading={ingesting} onClick={handleIngest}>
                {ingesting ? "Ingesting…" : "Ingest"}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setIsEditing(true)}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setConfirmDelete(true);
                  setIngestResult(null);
                }}
              >
                Delete
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="text-xs text-gray-400">Only company owners can manage content sources.</p>
      )}
    </Card>
  );
}
