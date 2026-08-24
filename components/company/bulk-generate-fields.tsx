"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { CalendarClock } from "lucide-react";
import { Alert } from "@/components/ui/Alert";
import { TimeSlotSelect } from "@/components/ui/TimeSlotSelect";
import { APP_TIME_ZONE, formatDate, formatDateTime } from "@/lib/i18n/format-date";
import { clampDayCount, customTotal, enumerateDays, syncDayTimes } from "@/lib/posts/bulk-form";
import {
  MAX_BULK_POSTS,
  parseTimeOfDay,
  type CustomDistributionError,
} from "@/lib/scheduling/bulk-schedule";
import { appZoneInstant } from "@/lib/scheduling/app-datetime-local";
import { SLOT_MINUTES } from "@/lib/scheduling/time-slots";

/** How the requested posts are laid out over the period. */
export type BulkDistribution = "even" | "custom";

export interface BulkPlanState {
  numberOfPosts: number;
  /**
   * Inclusive `YYYY-MM-DD` — the permitted period, not two publish dates. Read
   * as business-zone calendar days, the same as the times inside them.
   */
  startDate: string;
  endDate: string;
  distribution: BulkDistribution;
  /** Custom mode only: posts per `YYYY-MM-DD`. Days at 0 are simply not used. */
  counts: Record<string, number>;
  /**
   * Custom mode only: the `HH:mm` publish time of each post on a day, in the
   * business zone — `times[date][i]` belongs to post `i` of that day. Kept the
   * same length as `counts[date]` by `syncDayTimes`, so the list can never carry
   * a time for a post the day no longer has.
   */
  times: Record<string, string[]>;
}

interface Props {
  plan: BulkPlanState;
  onChange: (plan: BulkPlanState) => void;
  /**
   * The slots this plan would schedule, already computed by the parent with the
   * SAME planner the server uses. Passed in rather than derived here so the
   * preview and the submitted request can never be two different answers.
   */
  slots: Date[];
  /** Custom mode only: why the distribution is not usable yet, if it is not. */
  distributionError: CustomDistributionError | null;
  /**
   * The earliest day this period may start — today, in the business zone. Held
   * by the parent so it is read from the clock exactly once, and so the same
   * value gates the submit button as bounds these inputs.
   */
  minDate: string;
  /**
   * The clock this form opened on, held by the parent for the same reason
   * `minDate` is: a chosen time must not start failing while it is being read,
   * and the value that marks an input as past must be the one that gates the
   * submit button. The server re-checks against its own clock and is the
   * authority.
   */
  now: Date;
  /**
   * The selected channel's posting windows, used only to SEED a day's time
   * inputs. Nothing here reads them to schedule with — in custom mode the times
   * on screen are the times that get sent. With no windows there is nothing to
   * seed from, and the inputs open empty rather than at an invented hour.
   */
  postingWindows: unknown;
  /**
   * Selected channels that have no publishing times configured, by label.
   *
   * Even distribution is entirely a function of those times, so this list being
   * non-empty means the batch cannot be planned at all — the parent disables the
   * Generate button on the same condition, and the API refuses the request with
   * `NO_POSTING_WINDOWS` if it is made anyway. Custom mode is unaffected: there
   * the user names every time.
   */
  channelsWithoutWindows: string[];
  /** Channel settings, where the missing schedule is configured. */
  channelSettingsHref: string;
  /** Saves the half-filled batch before the CTA above navigates away from it. */
  onLeaveForSettings?: () => void;
  disabled: boolean;
  locale: string;
}

const FIELD_CLASS =
  "rounded-control border-border-strong bg-surface duration-fast focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2.5 text-sm transition-all outline-none focus:ring-2 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60";

const LABEL_CLASS = "text-fg-muted mb-1.5 block text-sm font-medium";

/**
 * The fields that turn "generate a post" into "generate several".
 *
 * Everything shared with a single generation — channel, source, language, image,
 * model — stays in the parent form and is applied to every post in the batch
 * unchanged. This component owns only the four decisions a batch adds: how many,
 * over what period, laid out how, and (in custom mode) on which days.
 *
 * The preview is the point of the whole panel. Bulk generation writes real posts
 * with real publish times, so the times are shown BEFORE the run rather than
 * discovered afterwards in the grid.
 */
export function BulkGenerateFields({
  plan,
  onChange,
  slots,
  distributionError,
  minDate,
  now,
  postingWindows,
  channelsWithoutWindows,
  channelSettingsHref,
  onLeaveForSettings,
  disabled,
  locale,
}: Props) {
  const t = useTranslations("posts.generate.bulk");

  /**
   * Even distribution has no times to work from. Shown INSTEAD of the ordinary
   * even-mode hint, because that hint describes something this batch cannot do.
   */
  const evenUnplannable = plan.distribution === "even" && channelsWithoutWindows.length > 0;

  const days = enumerateDays(plan.startDate, plan.endDate);
  const assigned = customTotal(plan.counts);
  // `min` on the input stops the picker offering a past day; a value typed or
  // pasted straight into the field still reaches here, so it is also said out
  // loud. The server refuses it either way.
  const startInPast = plan.startDate < minDate;

  function update(patch: Partial<BulkPlanState>) {
    onChange({ ...plan, ...patch });
  }

  /**
   * Changing the period drops any per-day counts that fall outside it, so a
   * distribution can never quietly keep pointing at days the user can no longer
   * see — which the server would then reject as out_of_period.
   *
   * The times go with them. A day dropped from the period must not leave its
   * times behind: they would be invisible in the editor, ride along in the
   * request, and be rejected for a day the user can no longer even see.
   */
  function updateRange(patch: { startDate?: string; endDate?: string }) {
    const next = { ...plan, ...patch };
    const inRange = new Set(enumerateDays(next.startDate, next.endDate));
    next.counts = Object.fromEntries(
      Object.entries(plan.counts).filter(([date]) => inRange.has(date))
    );
    next.times = Object.fromEntries(
      Object.entries(plan.times).filter(([date]) => inRange.has(date))
    );
    onChange(next);
  }

  /**
   * A day's post count changed: resize its list of times to match.
   *
   * Both maps are written together, always — the count is what the request's
   * total is checked against and the times are what gets scheduled, so a state
   * where one has moved and the other has not is a request the API refuses
   * (`time_count_mismatch`). A day taken to 0 loses its times entirely rather
   * than keeping a hidden list that would come back if it were raised again.
   */
  function updateDayCount(date: string, raw: string) {
    const count = clampDayCount(raw);
    const times = { ...plan.times };
    if (count < 1) delete times[date];
    else times[date] = syncDayTimes(date, count, plan.times[date], postingWindows);

    onChange({ ...plan, counts: { ...plan.counts, [date]: count }, times });
  }

  /** One time picker changed; `value` is always one of the offered slots. */
  function updateDayTime(date: string, index: number, value: string) {
    const current = plan.times[date] ?? [];
    const next = current.map((time, i) => (i === index ? value : time));
    onChange({ ...plan, times: { ...plan.times, [date]: next } });
  }

  /**
   * Whether a chosen time has already gone by — the per-input half of the
   * `time_in_past` rule, so the offending field is visibly marked and not just
   * named in one line of text under the list.
   */
  function isPastTime(date: string, value: string): boolean {
    const time = parseTimeOfDay(value);
    if (time === null) return false; // invalid, not past — a different message
    const at = appZoneInstant(date, time.hour, time.minute);
    return at !== null && at.getTime() <= now.getTime();
  }

  return (
    <div className="border-border bg-surface-subtle rounded-card mt-4 border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[140px]">
          <label htmlFor="bulk-count" className={LABEL_CLASS}>
            {t("numberOfPosts")}
          </label>
          <input
            id="bulk-count"
            type="number"
            min={1}
            max={MAX_BULK_POSTS}
            value={plan.numberOfPosts}
            onChange={(e) =>
              update({
                numberOfPosts: Math.min(
                  MAX_BULK_POSTS,
                  Math.max(1, Number.parseInt(e.target.value, 10) || 1)
                ),
              })
            }
            disabled={disabled}
            className={FIELD_CLASS}
          />
        </div>

        <div className="min-w-[160px]">
          <label htmlFor="bulk-start" className={LABEL_CLASS}>
            {t("startDate")}
          </label>
          <input
            id="bulk-start"
            type="date"
            value={plan.startDate}
            min={minDate}
            aria-invalid={startInPast || undefined}
            onChange={(e) => updateRange({ startDate: e.target.value })}
            disabled={disabled}
            className={FIELD_CLASS}
          />
        </div>

        <div className="min-w-[160px]">
          <label htmlFor="bulk-end" className={LABEL_CLASS}>
            {t("endDate")}
          </label>
          <input
            id="bulk-end"
            type="date"
            value={plan.endDate}
            // The later of the two bounds: the end can never precede the start,
            // and neither end of the period may sit in the past.
            min={plan.startDate > minDate ? plan.startDate : minDate}
            onChange={(e) => updateRange({ endDate: e.target.value })}
            disabled={disabled}
            className={FIELD_CLASS}
          />
        </div>

        <div className="min-w-[200px]">
          <label htmlFor="bulk-distribution" className={LABEL_CLASS}>
            {t("distribution")}
          </label>
          <select
            id="bulk-distribution"
            value={plan.distribution}
            onChange={(e) => update({ distribution: e.target.value as BulkDistribution })}
            disabled={disabled}
            className={FIELD_CLASS}
          >
            <option value="even">{t("distributionEven")}</option>
            <option value="custom">{t("distributionCustom")}</option>
          </select>
        </div>
      </div>

      {startInPast && <p className="text-status-danger-fg mt-2 text-xs">{t("startInPast")}</p>}

      {/* The dates are a period, not two publishing dates — said once, here,
          because it is the one thing about this form that is not obvious. */}
      {/* The custom hint carries the slot rule with it: it is only in that mode
          that anyone picks a time, so it is only there that the half hours the
          pickers offer need explaining. */}
      {!evenUnplannable && (
        <p className="text-fg-faint mt-2 text-xs">
          {plan.distribution === "even"
            ? t("evenHint")
            : `${t("customHint")} ${t("slotHint", { minutes: SLOT_MINUTES })}`}
        </p>
      )}

      {/* No posting schedule, so an even spread has no hours to spread over —
          and none is invented. Both ways out are offered: configure the channel,
          or switch to custom and name the times here. Not a validation error
          under a field, because nothing on this form is wrong — the channel is
          simply not set up for this mode yet. */}
      {evenUnplannable && (
        <Alert variant="warning" className="mt-3">
          <p>{t("noPostingWindows", { channels: channelsWithoutWindows.join(", ") })}</p>
          <p className="mt-1.5">
            <Link
              href={channelSettingsHref}
              onClick={onLeaveForSettings}
              className="text-accent font-medium underline underline-offset-2"
            >
              {t("noPostingWindowsSettings")}
            </Link>
            {" · "}
            <button
              type="button"
              onClick={() => update({ distribution: "custom" })}
              disabled={disabled}
              className="text-accent font-medium underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t("noPostingWindowsCustom")}
            </button>
          </p>
        </Alert>
      )}

      {plan.distribution === "custom" && (
        <div className="mt-4">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <span className="text-fg text-sm font-medium">{t("perDayTitle")}</span>
            <span
              className={
                assigned === plan.numberOfPosts
                  ? "text-status-success-fg text-xs font-medium"
                  : "text-fg-muted text-xs"
              }
            >
              {t("assignedOf", { assigned, requested: plan.numberOfPosts })}
            </span>
          </div>

          {days.length === 0 ? (
            <p className="text-fg-faint text-xs">{t("noDaysInRange")}</p>
          ) : (
            <div className="border-border bg-surface rounded-control max-h-56 overflow-y-auto border">
              {days.map((date) => {
                const count = plan.counts[date] ?? 0;
                const times = plan.times[date] ?? [];

                return (
                  <div key={date} className="border-border/60 border-b px-3 py-2 last:border-b-0">
                    <div className="flex items-center justify-between gap-3">
                      {/* Midday, not midnight: timestamps render in the business
                          zone, and a UTC midnight would label this row with the
                          previous day west of it while the request still carries
                          `date`. */}
                      <label htmlFor={`bulk-day-${date}`} className="text-fg-muted text-sm">
                        {formatDate(`${date}T12:00:00.000Z`, locale)}
                      </label>
                      <input
                        id={`bulk-day-${date}`}
                        type="number"
                        min={0}
                        max={MAX_BULK_POSTS}
                        value={count}
                        onChange={(e) => updateDayCount(date, e.target.value)}
                        disabled={disabled}
                        aria-label={t("postsOnDay", { date })}
                        className="rounded-control border-border-strong bg-surface focus:border-accent focus:ring-accent/20 w-20 border px-2 py-1 text-sm outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </div>

                    {/* One time input per post assigned to this day — the whole
                        point of the mode. Seeded from the channel's windows and
                        then entirely the user's: these values are what the
                        request carries and what gets scheduled.

                        A channel with no windows seeds nothing, so these open
                        EMPTY and are marked as such. That is the mode working as
                        intended — the user names the times — rather than a form
                        that failed to fill itself in. */}
                    {count > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 pl-1">
                        {times.map((time, i) => (
                          <div key={i} className="flex items-center gap-1.5">
                            <span className="text-fg-faint text-xs tabular-nums">{i + 1}.</span>
                            <TimeSlotSelect
                              value={time}
                              onChange={(value) => updateDayTime(date, i, value)}
                              disabled={disabled}
                              invalid={time === "" || isPastTime(date, time)}
                              placeholder={t("timeUnset")}
                              aria-label={t("timeForPost", { index: i + 1, date })}
                              className="w-24 px-2 py-1 text-sm"
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* The exact same check the server runs, so the button is never
              enabled for a request the API would turn down. */}
          {distributionError !== null && (
            <p className="text-status-danger-fg mt-2 text-xs">
              {t(`distributionError_${distributionError}`)}
            </p>
          )}
        </div>
      )}

      {/* ── Preview ──────────────────────────────────────────────────────── */}
      <div className="mt-4">
        <div className="text-fg mb-2 flex items-center gap-1.5 text-sm font-medium">
          <CalendarClock className="h-4 w-4" aria-hidden />
          {t("previewTitle")}
        </div>

        {slots.length === 0 ? (
          <p className="text-fg-faint text-xs">{t("previewEmpty")}</p>
        ) : (
          <>
            <ol className="flex flex-wrap gap-1.5">
              {slots.map((slot, i) => (
                <li
                  key={`${slot.getTime()}-${i}`}
                  className="border-border bg-surface text-fg-muted rounded-control border px-2.5 py-1 text-xs"
                >
                  {formatDateTime(slot, locale)}
                </li>
              ))}
            </ol>
            {/* These are the channel's posting windows on the clock the company
                works to, not the viewer's own and not UTC. Worth saying once,
                beside the only place the app shows a list of future times. */}
            <p className="text-fg-faint mt-2 text-xs">
              {t("timeZoneHint", { zone: APP_TIME_ZONE })}
            </p>
          </>
        )}
      </div>

      <Alert variant="info" className="mt-4">
        {t("workflowNote")}
      </Alert>
    </div>
  );
}
