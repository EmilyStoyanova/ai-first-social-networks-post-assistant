"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Archive, ExternalLink, RotateCcw } from "lucide-react";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CompetitorForm } from "./competitor-form";
import type { CompetitorListItem } from "@/lib/services/competitive-analysis/competitor-dto";
import type { CompetitorInput } from "@/lib/validators/competitor.schema";

interface Props {
  slug: string;
  competitor: CompetitorListItem;
  canManage: boolean;
  onUpdate: (competitor: CompetitorListItem) => void;
  onArchiveToggled: (competitor: CompetitorListItem) => void;
  onDeleted: (id: string) => void;
}

export function CompetitorCard({
  slug,
  competitor,
  canManage,
  onUpdate,
  onArchiveToggled,
  onDeleted,
}: Props) {
  const t = useTranslations("competitiveAnalysis.competitors");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();

  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");

  const [archiving, setArchiving] = useState(false);
  const [actionError, setActionError] = useState("");

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isArchived = competitor.archivedAt !== null;
  const base = `/api/v1/companies/${slug}/competitive-analysis/competitors/${competitor.id}`;

  async function handleSave(data: CompetitorInput) {
    setSaving(true);
    setEditError("");
    try {
      const res = await fetch(base, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { competitor: CompetitorListItem };
      onUpdate(json.competitor);
      setIsEditing(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setSaving(false);
    }
  }

  async function handleArchiveToggle() {
    setArchiving(true);
    setActionError("");
    try {
      const res = await fetch(`${base}/${isArchived ? "restore" : "archive"}`, { method: "POST" });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { competitor: CompetitorListItem };
      onArchiveToggled(json.competitor);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setArchiving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setActionError("");
    try {
      const res = await fetch(base, { method: "DELETE" });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      onDeleted(competitor.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (isEditing) {
    return (
      <Card className="px-5 py-5">
        {editError && (
          <Alert variant="error" className="mb-3">
            {editError}
          </Alert>
        )}
        <CompetitorForm
          initialData={competitor}
          saving={saving}
          onSave={handleSave}
          onCancel={() => {
            setIsEditing(false);
            setEditError("");
          }}
        />
      </Card>
    );
  }

  return (
    <Card className="px-5 py-5">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="text-fg truncate text-sm font-semibold">{competitor.name}</h3>
            {isArchived && <Badge variant="neutral">{t("archived")}</Badge>}
          </div>
          {competitor.country && <p className="text-fg-faint text-xs">{competitor.country}</p>}
        </div>
      </div>

      {competitor.website && (
        <a
          href={competitor.website}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:text-fg duration-fast mb-2 inline-flex items-center gap-1 text-xs transition-colors"
        >
          {competitor.website}
          <ExternalLink size={11} aria-hidden="true" />
        </a>
      )}

      {competitor.notes && (
        <p className="text-fg-muted mb-3 line-clamp-3 text-xs">{competitor.notes}</p>
      )}

      {competitor.socialProfiles.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {competitor.socialProfiles.map((profile) => (
            <a
              key={profile.id}
              href={profile.url}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-surface-subtle text-fg-muted hover:text-fg duration-fast inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-colors"
            >
              {profile.label || t(`socialProfiles.platforms.${profile.platform}`)}
              <ExternalLink size={10} aria-hidden="true" />
            </a>
          ))}
        </div>
      )}

      {actionError && (
        <Alert variant="error" className="mb-3">
          {actionError}
        </Alert>
      )}

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setIsEditing(true)}>
            {tCommon("edit")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={archiving}
            onClick={handleArchiveToggle}
            leftIcon={
              isArchived ? (
                <RotateCcw size={14} aria-hidden="true" />
              ) : (
                <Archive size={14} aria-hidden="true" />
              )
            }
          >
            {isArchived ? t("restore") : t("archive")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
            {t("deletePermanently")}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
        title={t("deleteConfirmTitle")}
        body={t("deleteConfirmBody", { name: competitor.name })}
        confirmLabel={t("deletePermanently")}
        tone="danger"
        loading={deleting}
        requireText={competitor.name}
      />
    </Card>
  );
}
