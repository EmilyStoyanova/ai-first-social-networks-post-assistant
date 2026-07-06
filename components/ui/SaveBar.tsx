"use client";

import { useTranslations } from "next-intl";
import { Button } from "./Button";

interface Props {
  dirty: boolean;
  saving?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** Override labels; defaults come from common.save / common.cancel. */
  saveLabel?: string;
  discardLabel?: string;
}

// Sticky dirty-form footer (§7 #30) — appears only when the form is dirty.
export function SaveBar({
  dirty,
  saving = false,
  onSave,
  onDiscard,
  saveLabel,
  discardLabel,
}: Props) {
  const t = useTranslations("common");

  if (!dirty) return null;

  return (
    <div className="rounded-card animate-panel-in border-border bg-surface sticky bottom-4 z-40 flex items-center justify-end gap-2 border px-4 py-3 shadow-md">
      <Button variant="secondary" onClick={onDiscard} disabled={saving}>
        {discardLabel ?? t("cancel")}
      </Button>
      <Button variant="primary" onClick={onSave} loading={saving}>
        {saveLabel ?? t("save")}
      </Button>
    </div>
  );
}
