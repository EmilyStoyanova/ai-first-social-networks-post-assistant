"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Users } from "lucide-react";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { CompetitorCard } from "./competitor-card";
import { CompetitorForm } from "./competitor-form";
import type { CompetitorListItem } from "@/lib/services/competitive-analysis/competitor-dto";
import type { CompetitorInput } from "@/lib/validators/competitor.schema";

interface Props {
  slug: string;
  initialCompetitors: CompetitorListItem[];
  canManage: boolean;
}

type ViewFilter = "active" | "archived";

export function CompetitorsPanel({ slug, initialCompetitors, canManage }: Props) {
  const t = useTranslations("competitiveAnalysis.competitors");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();

  const [competitors, setCompetitors] = useState(initialCompetitors);
  const [filter, setFilter] = useState<ViewFilter>("active");
  const [showAddForm, setShowAddForm] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

  const visible = useMemo(
    () => competitors.filter((c) => (filter === "active" ? !c.archivedAt : !!c.archivedAt)),
    [competitors, filter]
  );
  const archivedCount = useMemo(
    () => competitors.filter((c) => c.archivedAt).length,
    [competitors]
  );

  async function handleAdd(data: CompetitorInput) {
    setAdding(true);
    setAddError("");
    try {
      const res = await fetch(`/api/v1/companies/${slug}/competitive-analysis/competitors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { competitor: CompetitorListItem };
      setCompetitors((prev) => [json.competitor, ...prev]);
      setShowAddForm(false);
      setFilter("active");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setAdding(false);
    }
  }

  function handleUpdate(updated: CompetitorListItem) {
    setCompetitors((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  }

  function handleDeleted(id: string) {
    setCompetitors((prev) => prev.filter((c) => c.id !== id));
  }

  return (
    <div className="space-y-4">
      {/* Active / Archived filter — only shown once there is something archived
          to switch to, so a company with no archived competitors never sees a
          toggle with nothing behind it. */}
      {archivedCount > 0 && (
        <div className="flex gap-1.5">
          <Button
            variant={filter === "active" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setFilter("active")}
          >
            {t("filterActive", { count: competitors.length - archivedCount })}
          </Button>
          <Button
            variant={filter === "archived" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setFilter("archived")}
          >
            {t("filterArchived", { count: archivedCount })}
          </Button>
        </div>
      )}

      {showAddForm && canManage && (
        <div className="rounded-card border-border bg-surface border px-5 py-5 shadow-sm">
          <h3 className="text-fg mb-4 text-sm font-semibold">{t("newCompetitor")}</h3>
          {addError && (
            <Alert variant="error" className="mb-4">
              {addError}
            </Alert>
          )}
          <CompetitorForm
            saving={adding}
            onSave={handleAdd}
            onCancel={() => {
              setShowAddForm(false);
              setAddError("");
            }}
          />
        </div>
      )}

      {visible.length === 0 && !showAddForm ? (
        <EmptyState
          icon={<Users className="h-5 w-5" />}
          title={filter === "active" ? t("noCompetitorsTitle") : t("noArchivedTitle")}
          description={
            filter === "active"
              ? canManage
                ? t("noCompetitorsDesc")
                : t("noCompetitorsDescReadOnly")
              : t("noArchivedDesc")
          }
          action={
            filter === "active" && canManage ? (
              <Button variant="primary" size="sm" onClick={() => setShowAddForm(true)}>
                {t("addCompetitor")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((competitor) => (
              <CompetitorCard
                key={competitor.id}
                slug={slug}
                competitor={competitor}
                canManage={canManage}
                onUpdate={handleUpdate}
                onArchiveToggled={handleUpdate}
                onDeleted={handleDeleted}
              />
            ))}
          </div>

          {canManage && !showAddForm && filter === "active" && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowAddForm(true)}
              leftIcon={<Plus size={14} aria-hidden="true" />}
            >
              {t("addCompetitor")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
