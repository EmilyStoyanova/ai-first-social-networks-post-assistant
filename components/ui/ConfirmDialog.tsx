"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { Textarea } from "./Textarea";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Receives the notes text when `notesField` is set. */
  onConfirm: (notes?: string) => void;
  title: string;
  body?: React.ReactNode;
  confirmLabel: string;
  tone?: "danger" | "default";
  loading?: boolean;
  /** Typed-name confirmation — the expected text (case-insensitive, paste allowed §11). */
  requireText?: string;
  /** Optional notes textarea (e.g. reject notes). */
  notesField?: { label: string; placeholder?: string };
}

// Standard destructive confirm (§7 #28). Destructive actions always confirm —
// nothing else does (Principle 10). Button order: destructive left of primary
// never applies here; Cancel left, confirm right.
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  tone = "default",
  loading = false,
  requireText,
  notesField,
}: Props) {
  const t = useTranslations("common");
  const [typed, setTyped] = useState("");
  const [notes, setNotes] = useState("");

  const confirmBlocked = requireText
    ? typed.trim().toLowerCase() !== requireText.trim().toLowerCase()
    : false;

  function handleClose() {
    setTyped("");
    setNotes("");
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title={title} maxWidth="md">
      {body && <div className="text-body text-fg-muted">{body}</div>}

      {requireText && (
        <div className="mt-4">
          <label htmlFor="confirm-text" className="text-small mb-label text-fg block font-semibold">
            {requireText}
          </label>
          <input
            id="confirm-text"
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            className="text-body rounded-control border-border bg-surface text-fg duration-fast placeholder:text-fg-faint focus-visible:outline-accent h-9 w-full border px-3 transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-0"
          />
        </div>
      )}

      {notesField && (
        <Textarea
          id="confirm-notes"
          label={notesField.label}
          placeholder={notesField.placeholder}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="mt-4"
        />
      )}

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={handleClose} disabled={loading}>
          {t("cancel")}
        </Button>
        <Button
          variant={tone === "danger" ? "danger" : "primary"}
          onClick={() => onConfirm(notesField ? notes : undefined)}
          disabled={confirmBlocked}
          loading={loading}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
