"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { formatDate } from "@/lib/i18n/format-date";
import type { AnalyticsKeyStatus } from "@/lib/services/analytics/manage-analytics-key.service";

/** The sync summary the save endpoint returns for its automatic first sync. */
interface SyncSummary {
  skipped: boolean;
  reason?: string;
  examined: number;
  updated: number;
  noData: number;
  forbidden: number;
  failed: number;
}

interface Props {
  slug: string;
  initialStatus: AnalyticsKeyStatus;
  canManage: boolean;
  /**
   * Whether `initialStatus` reflects the stored key at all.
   *
   * The status service is owner-scoped and answers FORBIDDEN to editors, so for
   * them the caller has nothing real to pass. False means "this is a placeholder
   * — say the status is hidden", never "the key is not configured": showing an
   * editor a Disabled badge on a company whose analytics work fine reports a
   * permission limit as a setup problem, and sends them looking for a setting
   * they will never find.
   */
  canReadStatus?: boolean;
}

/**
 * Buffer Personal API Key settings (v2-7).
 *
 * Separate card from BufferConnectionCard on purpose: this is a different
 * credential with a different lifecycle (manual, revocable, non-expiring) doing a
 * different job (analytics reads). Folding it into the connection card would
 * imply that removing it affects publishing, which it does not.
 *
 * The raw key is write-only from the UI's perspective — it is sent on save and
 * never returned, so the field always starts empty and the stored key is
 * represented only by its last 4 characters.
 */
export function AnalyticsKeyCard({ slug, initialStatus, canManage, canReadStatus = true }: Props) {
  const router = useRouter();
  const t = useTranslations("analytics");
  const tCommon = useTranslations("common");

  const [status, setStatus] = useState(initialStatus);
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editing, setEditing] = useState(false);

  async function handleSave() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const res = await fetch(`/api/v1/companies/${slug}/buffer/analytics-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: keyInput }),
      });
      const json = (await res.json()) as {
        data?: AnalyticsKeyStatus & {
          organizationName: string;
          sync: SyncSummary | null;
        };
        error?: { message?: string };
      };

      if (!res.ok || !json.data) {
        // The server already tested the key against Buffer, so its message
        // distinguishes "rejected" from "cannot read insights" from "Buffer
        // unreachable" — surface it rather than a generic failure.
        throw new Error(json.error?.message ?? tCommon("somethingWentWrong"));
      }

      setStatus(json.data);
      setKeyInput("");
      setEditing(false);

      const saved = t("keySavedFor", { organization: json.data.organizationName });
      const outcome = describeSync(json.data.sync);

      // The key is stored either way — a sync problem is a warning appended to a
      // successful save, never a failed save (requirement: keep the valid key).
      if (outcome.kind === "warning") {
        setSuccess(saved);
        setError(outcome.message);
      } else {
        setSuccess(`${saved} ${outcome.message}`);
        if (outcome.refresh) router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    setError("");
    setSuccess("");
    try {
      const res = await fetch(`/api/v1/companies/${slug}/buffer/analytics-key`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(tCommon("somethingWentWrong"));
      setStatus({ ...status, configured: false, last4: null, addedAt: null, lastValidAt: null });
      setConfirmRemove(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setRemoving(false);
    }
  }

  /**
   * Interpretation of the automatic first sync that follows a save.
   *
   * There is no manual refresh: after this one setup sync, metrics are re-read by
   * the daily cron, so every message here describes a one-off setup outcome and
   * never asks the user to press anything.
   *
   * A null summary means the sync threw server-side; the key is still saved.
   */
  function describeSync(sync: SyncSummary | null): {
    kind: "success" | "warning";
    message: string;
    refresh?: boolean;
  } {
    if (sync === null) return { kind: "warning", message: t("syncFailedAfterSave") };
    if (sync.skipped) {
      return { kind: "warning", message: t(`syncSkipped.${sync.reason ?? "NO_KEY"}`) };
    }
    if (sync.examined === 0) return { kind: "success", message: t("syncNoPosts") };
    if (sync.updated === 0 && sync.forbidden > 0) {
      return { kind: "success", message: t("syncAllForbidden") };
    }
    if (sync.updated === 0) {
      // Buffer ingests once a day, so a post published hours ago genuinely has
      // nothing yet. That is not a failure.
      return { kind: "success", message: t("syncNoDataYet", { examined: sync.examined }) };
    }
    return {
      kind: "success",
      message: t("syncDone", { updated: sync.updated, examined: sync.examined }),
      // Metrics render server-side; refresh re-runs the page's data fetch without
      // discarding this card's state the way a full reload would.
      refresh: true,
    };
  }

  const showForm = canManage && (!status.configured || editing);

  return (
    <div id="analytics">
      <Card className="px-6 py-6">
        <div className="mb-1 flex items-center justify-between gap-4">
          <h2 className="text-fg text-sm font-semibold">{t("title")}</h2>
          {/* No badge when the status is unreadable — an enabled/disabled pill
              would be a claim this viewer's permissions cannot support. */}
          {canReadStatus && (
            <Badge variant={status.configured ? "success" : "neutral"}>
              {status.configured ? t("enabled") : t("disabled")}
            </Badge>
          )}
        </div>

        <p className="text-fg-muted mb-4 text-sm leading-relaxed">{t("description")}</p>

        {error && (
          <Alert variant="error" className="mb-4">
            {error}
          </Alert>
        )}
        {success && (
          <Alert variant="success" className="mb-4">
            {success}
          </Alert>
        )}

        {!canReadStatus ? (
          /* An editor. The key's state is genuinely unknown here, so the card
             says so and stops — no badge, no details, no "not configured". */
          <p className="text-fg-muted text-xs">{t("ownersOnlyStatus")}</p>
        ) : /* Buffer itself must be connected first — analytics read metrics for posts
          published through it, so there is nothing to read without a connection. */
        !status.bufferConnected ? (
          <Alert variant="info">{t("connectBufferFirst")}</Alert>
        ) : (
          <>
            {status.configured && !editing && (
              <dl className="mb-4 space-y-1.5">
                <div className="flex items-center gap-2 text-sm">
                  <dt className="text-fg-muted">{t("key")}</dt>
                  <dd className="text-fg font-medium tabular-nums">••••••••{status.last4}</dd>
                </div>
                {status.addedAt && (
                  <div className="flex items-center gap-2 text-sm">
                    <dt className="text-fg-muted">{t("addedOn")}</dt>
                    <dd className="text-fg">{formatDate(String(status.addedAt))}</dd>
                  </div>
                )}
                {/* "Last checked" — stamped by the daily sync every time Buffer
                    answers, so it is also the proof that the automatic refresh is
                    running. Left untouched by a failed refresh. */}
                <div className="flex items-center gap-2 text-sm">
                  <dt className="text-fg-muted">{t("lastVerified")}</dt>
                  <dd className="text-fg">
                    {status.lastValidAt ? formatDate(String(status.lastValidAt)) : t("never")}
                  </dd>
                </div>
              </dl>
            )}

            {/* There is no refresh button by design. Saying so pre-empts the
                search for one, and sets the expectation of a daily cadence. */}
            {status.configured && !editing && (
              <p className="text-fg-muted mb-4 text-xs">{t("autoRefreshNote")}</p>
            )}

            {showForm && (
              <div className="mb-4">
                <label htmlFor="analytics-key" className="text-fg mb-1.5 block text-sm font-medium">
                  {t("keyLabel")}
                </label>
                {/* A raw input rather than <Input>: this field is controlled (the
                  value is cleared after a successful save so the key is never
                  left sitting in the DOM), and <Input> is uncontrolled by design.
                  Classes mirror components/ui/Input.tsx so it looks identical. */}
                <input
                  id="analytics-key"
                  name="analyticsKey"
                  type="password"
                  autoComplete="off"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder={t("keyPlaceholder")}
                  className="text-body rounded-control bg-surface text-fg duration-fast placeholder:text-fg-faint focus-visible:outline-accent border-border h-9 w-full border px-3 transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-0"
                />
                <p className="text-fg-muted mt-1.5 text-xs">{t("keyHelp")}</p>
              </div>
            )}

            {!canManage && <p className="text-fg-muted mb-3 text-xs">{t("ownersOnly")}</p>}

            {canManage && (
              <div className="flex flex-wrap items-center gap-3">
                {showForm && (
                  <Button
                    variant="primary"
                    loading={saving}
                    disabled={keyInput.trim().length === 0}
                    onClick={handleSave}
                  >
                    {/* Saving runs a real Buffer call before storing anything. */}
                    {saving ? t("savingAndSyncing") : t("verifyAndSave")}
                  </Button>
                )}

                {showForm && editing && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditing(false);
                      setKeyInput("");
                      setError("");
                    }}
                  >
                    {tCommon("cancel")}
                  </Button>
                )}

                {status.configured && !editing && !confirmRemove && (
                  <>
                    <Button variant="secondary" onClick={() => setEditing(true)}>
                      {t("replaceKey")}
                    </Button>
                    <Button variant="danger" onClick={() => setConfirmRemove(true)}>
                      {t("removeKey")}
                    </Button>
                  </>
                )}

                {confirmRemove && (
                  <>
                    <span className="text-fg-muted text-sm">{t("confirmRemove")}</span>
                    <Button variant="danger" loading={removing} onClick={handleRemove}>
                      {removing ? tCommon("deleting") : tCommon("confirm")}
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
                      {tCommon("cancel")}
                    </Button>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
