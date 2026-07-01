"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ContentSourceCard } from "./content-source-card";
import { ContentSourceForm } from "./content-source-form";
import type { ContentSourceItem } from "@/lib/services/company/list-content-sources.service";
import type { ContentSourcePayload } from "./content-source-form";

interface Props {
  slug: string;
  initialSources: ContentSourceItem[];
  canManage: boolean;
}

export function ContentSourcesSection({ slug, initialSources, canManage }: Props) {
  const [sources, setSources] = useState(initialSources);
  const [showAddForm, setShowAddForm] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

  async function handleAdd(data: ContentSourcePayload) {
    setAdding(true);
    setAddError("");
    try {
      const res = await fetch(`/api/v1/companies/${slug}/content-sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(json.error?.message ?? "Failed to add source.");
      }
      const json = (await res.json()) as { source: ContentSourceItem };
      setSources((prev) => [...prev, json.source]);
      setShowAddForm(false);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setAdding(false);
    }
  }

  function handleDelete(id: string) {
    setSources((prev) => prev.filter((s) => s.id !== id));
  }

  function handleUpdate(updated: ContentSourceItem) {
    setSources((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  }

  return (
    <div className="space-y-4">
      {/* Add source form */}
      {showAddForm && canManage && (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-5 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold text-gray-900">New content source</h3>
          {addError && (
            <Alert variant="error" className="mb-4">
              {addError}
            </Alert>
          )}
          <ContentSourceForm
            saving={adding}
            onSave={handleAdd}
            onCancel={() => {
              setShowAddForm(false);
              setAddError("");
            }}
          />
        </div>
      )}

      {/* Source list */}
      {sources.length === 0 && !showAddForm ? (
        <EmptyState
          title="No content sources yet"
          description={
            canManage
              ? "Add an RSS feed, manual prompt, product page, or calendar event to start building content context for AI generation."
              : "No content sources have been configured for this company."
          }
          action={
            canManage ? (
              <Button variant="primary" size="sm" onClick={() => setShowAddForm(true)}>
                Add source
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {sources.map((source) => (
              <ContentSourceCard
                key={source.id}
                slug={slug}
                source={source}
                canManage={canManage}
                onDelete={handleDelete}
                onUpdate={handleUpdate}
              />
            ))}
          </div>

          {canManage && !showAddForm && (
            <Button variant="secondary" size="sm" onClick={() => setShowAddForm(true)}>
              Add source
            </Button>
          )}
        </>
      )}
    </div>
  );
}
