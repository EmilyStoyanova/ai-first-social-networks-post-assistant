"use client";

import { useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { CalendarClock } from "lucide-react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { TimeSlotSelect } from "@/components/ui/TimeSlotSelect";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { APP_TIME_ZONE, formatDateTime } from "@/lib/i18n/format-date";
import { decidePublish } from "@/lib/scheduling/publish-window";
import { fromAppDateTimeLocal, toAppDateTimeLocal } from "@/lib/scheduling/app-datetime-local";
import { SLOT_MINUTES, snapToSlot } from "@/lib/scheduling/time-slots";

/** A store that never changes — only the server/client snapshot split is wanted. */
const NEVER_CHANGES = () => () => {};

interface Props {
  postId: string;
  /**
   * ISO instant the post is due to go out, or null when it has no time yet.
   * Null is the ordinary state of a manually generated draft, not an edge case.
   */
  scheduledFor: string | null;
  /**
   * Whether a PERSON chose that time. False covers two different posts — one
   * with no time at all, and a cron post carrying the weekly filler's estimate —
   * and both are treated the same way here, because neither has a publish time
   * anybody promised.
   */
  manuallyScheduled: boolean;
  /** Whether the editor is showing. Owned by the card, which also owns the button. */
  open: boolean;
  onClose: () => void;
  /** The saved instant, ISO. The card is the one holding the post's schedule. */
  onScheduled: (scheduledFor: string) => void;
}

/**
 * A post's publish time, and the form for choosing one.
 *
 * ── What is shown, and when ─────────────────────────────────────────────────
 *
 * The "Scheduled for …" line appears only for a MANUALLY scheduled post: its
 * time is a promise the publisher keeps exactly (lib/scheduling/publish-window),
 * so it is worth stating. An automatic post's `scheduledFor` is the weekly
 * filler's estimate, which the publisher may bring forward by up to 48 hours —
 * presenting that as a commitment would be a lie, so it reads as unscheduled
 * here and the card offers to give it a real time instead.
 *
 * The past-due notice is the visible half of the past-due policy: the publisher
 * refuses to fire a long-missed post rather than sending it late and silently, so
 * something has to say so and offer the one way out.
 *
 * ── Why the button is not in here ───────────────────────────────────────────
 *
 * It belongs in the card's action bar, beside Approve, Edit and Delete —
 * scheduling is one of the things a person does to a post, and putting it
 * anywhere else would make it the one action that lives somewhere of its own.
 * So the card owns `open`, and this component owns everything the schedule
 * itself needs: the two fields, the conversion, the request, and the errors.
 */
export function PostSchedulePanel({
  postId,
  scheduledFor,
  manuallyScheduled,
  open,
  onClose,
  onScheduled,
}: Props) {
  const t = useTranslations("posts.schedule");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();

  // The chosen instant, split the way it is chosen: a calendar day, and one of
  // the times the publishing sweep can hit. Both are business-zone wall clock,
  // and only `fromAppDateTimeLocal` turns them back into an instant.
  //
  // Seeded from the post's own time whenever it has one — including an automatic
  // estimate, which is a perfectly good starting value even though it is not
  // shown as a commitment. The time of day is snapped, because a post at 16:15
  // is published by the 16:30 sweep anyway, so 16:30 is what its time already
  // meant and it is the value the picker can offer. Nothing is written until
  // Save; an existing off-slot time is not migrated behind anyone's back, and
  // the line above keeps reading back the real one.
  const [day, setDay] = useState(() =>
    scheduledFor === null ? "" : toAppDateTimeLocal(scheduledFor).slice(0, 10)
  );
  const [time, setTime] = useState(() =>
    scheduledFor === null ? "" : (snapToSlot(toAppDateTimeLocal(scheduledFor).slice(11, 16)) ?? "")
  );
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

  const showsTime = manuallyScheduled && scheduledFor !== null;

  const pastDue =
    hydrated &&
    showsTime &&
    decidePublish({ scheduledFor: new Date(scheduledFor), manuallyScheduled: true }, new Date()) ===
      "past_due";

  async function handleSave() {
    const instant = day === "" || time === "" ? null : fromAppDateTimeLocal(`${day}T${time}`);
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
      onScheduled(json.scheduledFor);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setSaving(false);
    }
  }

  // Nothing to say about a post with no promised time and no open editor. The
  // card still offers the button — that is where "this post is unscheduled"
  // shows, rather than in an empty box here.
  if (!showsTime && !open) return null;

  return (
    <div className="mb-3">
      {showsTime && (
        <div className="text-fg-muted flex flex-wrap items-center gap-2 text-xs">
          <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{t("scheduledFor", { date: formatDateTime(scheduledFor) })}</span>
        </div>
      )}

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
            {showsTime ? t("newTime") : t("publishTime")}
          </label>
          {/* A date and a slot, not a datetime-local: the publishing sweep runs
              every half hour, so those are the only times a post can actually
              go out at. */}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <input
              id={`reschedule-${postId}`}
              type="date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              disabled={saving}
              aria-label={t("newDate")}
              className="rounded-control border-border bg-surface focus:border-accent focus:ring-accent/30 border px-3 py-2 text-xs outline-none focus:ring-2"
            />
            <TimeSlotSelect
              value={time}
              onChange={setTime}
              disabled={saving}
              aria-label={t("newTimeOfDay")}
              className="px-3 py-2 text-xs"
            />
          </div>
          <p className="text-fg-faint mb-2 text-xs">
            {t("slotHint", { minutes: SLOT_MINUTES })} {t("timeZoneHint", { zone: APP_TIME_ZONE })}
          </p>
          {/* Scheduling is not approval, and a card that quietly implied
              otherwise would be inviting someone to think the post is on its
              way out. The sweep publishes it at this time only once it has
              been approved — see approvePost. */}
          <p className="text-fg-faint mb-2 text-xs">{t("approvalStillRequired")}</p>
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
              disabled={day === "" || time === ""}
              onClick={handleSave}
            >
              {saving ? t("saving") : t("save")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onClose();
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
