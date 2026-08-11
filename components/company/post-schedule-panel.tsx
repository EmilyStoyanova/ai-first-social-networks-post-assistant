"use client";

import { useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { CalendarClock } from "lucide-react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { APP_TIME_ZONE, formatDateTime } from "@/lib/i18n/format-date";
import { decidePublish } from "@/lib/scheduling/publish-window";
import { canReschedule } from "@/lib/scheduling/reschedule-policy";
import { fromAppDateTimeLocal, toAppDateTimeLocal } from "@/lib/scheduling/app-datetime-local";
import type { PostRole } from "@/lib/posts/post-actions";

/** A store that never changes — only the server/client snapshot split is wanted. */
const NEVER_CHANGES = () => () => {};

interface Props {
  postId: string;
  /** ISO instant the post is due to go out. */
  scheduledFor: string;
  /** Uppercase status, as the card holds it. */
  status: string;
  role: PostRole;
}

/**
 * The publish time of a manually scheduled post, and the way to change it.
 *
 * Only manually scheduled posts get this: their time is a promise the publisher
 * keeps exactly (lib/scheduling/publish-window.ts), so it is worth showing and
 * worth being able to change. An automatic post's `scheduledFor` is the weekly
 * filler's estimate, and presenting it as a commitment would be a lie.
 *
 * The past-due notice is the visible half of the past-due policy: the publisher
 * refuses to fire a long-missed post rather than sending it late and silently, so
 * something has to say so and offer the one way out.
 */
export function PostSchedulePanel({ postId, scheduledFor, status, role }: Props) {
  const t = useTranslations("posts.schedule");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();

  const [when, setWhen] = useState(scheduledFor);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // "Is it past due?" depends on the current clock, and the server's clock is
  // not the viewer's — comparing during SSR would produce markup the client
  // disagrees with while hydrating (React #418). This resolves false through
  // hydration and true afterwards, so the notice appears in a second render
  // rather than in a mismatched first one.
  const hydrated = useSyncExternalStore(
    NEVER_CHANGES,
    () => true,
    () => false
  );

  // `generationBatchId` is only read as "a person chose this time", which is
  // exactly what `manuallyScheduled` means; the panel renders for nothing else.
  const pastDue =
    hydrated &&
    decidePublish({ scheduledFor: new Date(when), generationBatchId: "manual" }, new Date()) ===
      "past_due";

  const rescheduleAllowed = canReschedule(status, role === "owner");

  function handleOpen() {
    setValue(toAppDateTimeLocal(when));
    setError("");
    setOpen(true);
  }

  async function handleSave() {
    const instant = fromAppDateTimeLocal(value);
    if (instant === null) {
      setError(apiError({ code: "INVALID_SCHEDULE" }));
      return;
    }

    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/v1/posts/${postId}/reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledFor: instant }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { code?: string; message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { scheduledFor: string };
      setWhen(json.scheduledFor);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-3">
      <div className="text-fg-muted flex flex-wrap items-center gap-2 text-xs">
        <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{t("scheduledFor", { date: formatDateTime(when) })}</span>
        {rescheduleAllowed && !open && (
          <button
            type="button"
            onClick={handleOpen}
            className="text-fg-faint hover:text-fg underline transition-colors"
          >
            {t("reschedule")}
          </button>
        )}
      </div>

      {pastDue && !open && (
        <Alert variant="warning" role="status" className="mt-2">
          {t("pastDue")}
        </Alert>
      )}

      {open && (
        <div className="rounded-control border-border bg-surface-subtle mt-2 border px-4 py-3">
          <label
            htmlFor={`reschedule-${postId}`}
            className="text-fg-faint mb-1 block text-xs font-semibold tracking-wide uppercase"
          >
            {t("newTime")}
          </label>
          <input
            id={`reschedule-${postId}`}
            type="datetime-local"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={saving}
            className="rounded-control border-border bg-surface focus:border-accent focus:ring-accent/30 mb-2 w-full border px-3 py-2 text-xs outline-none focus:ring-2"
          />
          <p className="text-fg-faint mb-2 text-xs">{t("timeZoneHint", { zone: APP_TIME_ZONE })}</p>
          {error && (
            <Alert variant="error" className="mb-2">
              {error}
            </Alert>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={saving}
              disabled={value === ""}
              onClick={handleSave}
            >
              {saving ? t("saving") : t("save")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                setError("");
              }}
            >
              {tCommon("cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
