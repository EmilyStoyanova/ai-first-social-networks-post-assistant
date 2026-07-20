"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { formatDate } from "@/lib/i18n/format-date";
import type { AnalyticsKeyStatus } from "@/lib/services/analytics/manage-analytics-key.service";

interface Props {
  slug: string;
  initialStatus: AnalyticsKeyStatus;
  canManage: boolean;
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
export function AnalyticsKeyCard({ slug, initialStatus, canManage }: Props) {
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
        data?: AnalyticsKeyStatus & { organizationName: string };
        error?: { message?: string };
      };

      if (!res.ok || !json.data) {
        // The server already tested the key against Buffer, so its message
        // distinguishes "rejected" from "cannot read insights" from "Buffer
        // unreachable" — surface it rather than a generic failure.
        throw new Error(json.error?.message ?? tCommon("somethingWentWrong"));
      }

      setStatus(json.data);
      setSuccess(t("keySavedFor", { organization: json.data.organizationName }));
      setKeyInput("");
      setEditing(false);
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

  const [syncing, setSyncing] = useState(false);

  /**
   * Pulls metrics immediately rather than waiting for the nightly cron, which
   * processes one company per run and could otherwise leave a new key showing
   * nothing for days.
   */
  async function handleSync() {
    setSyncing(true);
    setError("");
    setSuccess("");
    try {
      const res = await fetch(`/api/v1/companies/${slug}/analytics/sync`, { method: "POST" });
      const json = (await res.json()) as {
        data?: {
          skipped: boolean;
          reason?: string;
          examined: number;
          updated: number;
          noData: number;
          forbidden: number;
        };
        error?: { message?: string };
      };

      if (!res.ok || !json.data) {
        throw new Error(json.error?.message ?? tCommon("somethingWentWrong"));
      }

      const d = json.data;
      if (d.skipped) {
        // A skipped run is not a crash — say which of the four causes it was.
        setError(t(`syncSkipped.${d.reason ?? "NO_KEY"}`));
      } else if (d.examined === 0) {
        setSuccess(t("syncNoPosts"));
      } else if (d.updated === 0 && d.forbidden > 0) {
        setSuccess(t("syncAllForbidden"));
      } else if (d.updated === 0) {
        // Buffer ingests once a day, so a post published hours ago genuinely has
        // nothing yet. Distinguish that from a failure.
        setSuccess(t("syncNoDataYet", { examined: d.examined }));
      } else {
        setSuccess(t("syncDone", { updated: d.updated, examined: d.examined }));
        // Metrics render server-side, so the cards only pick up new numbers on reload.
        setTimeout(() => window.location.reload(), 1200);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setSyncing(false);
    }
  }

  const showForm = canManage && (!status.configured || editing);

  return (
    <div id="analytics">
      <Card className="px-6 py-6">
        <div className="mb-1 flex items-center justify-between gap-4">
          <h2 className="text-fg text-sm font-semibold">{t("title")}</h2>
          <Badge variant={status.configured ? "success" : "neutral"}>
            {status.configured ? t("enabled") : t("disabled")}
          </Badge>
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

        {/* Buffer itself must be connected first — analytics read metrics for posts
          published through it, so there is nothing to read without a connection. */}
        {!status.bufferConnected ? (
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
                <div className="flex items-center gap-2 text-sm">
                  <dt className="text-fg-muted">{t("lastVerified")}</dt>
                  <dd className="text-fg">
                    {status.lastValidAt ? formatDate(String(status.lastValidAt)) : t("never")}
                  </dd>
                </div>
              </dl>
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
                    {saving ? t("verifying") : t("verifyAndSave")}
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
                    <Button variant="primary" loading={syncing} onClick={handleSync}>
                      {syncing ? t("syncing") : t("syncNow")}
                    </Button>
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
