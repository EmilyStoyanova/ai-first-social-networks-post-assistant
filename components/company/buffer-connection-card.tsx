"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

interface Props {
  slug: string;
  initialConnection: {
    connected: boolean;
    bufferUserId: string | null;
    connectedAt: string | null;
  };
  canManage: boolean;
  bufferParam: string | null;
}

function BufferIcon() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="40" height="40" rx="10" fill="#2563EB" />
      <rect x="11" y="13" width="18" height="3" rx="1.5" fill="white" />
      <rect x="11" y="19" width="18" height="3" rx="1.5" fill="white" />
      <rect x="11" y="25" width="18" height="3" rx="1.5" fill="white" />
    </svg>
  );
}

export function BufferConnectionCard({ slug, initialConnection, canManage, bufferParam }: Props) {
  const t = useTranslations("buffer");
  const tCommon = useTranslations("common");
  const [connection, setConnection] = useState(initialConnection);
  const [uiStatus, setUiStatus] = useState<"idle" | "disconnecting" | "error">("idle");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const connected = connection.connected;

  function handleConnect() {
    window.location.href = `/api/v1/companies/${slug}/buffer/connect`;
  }

  async function handleDisconnect() {
    setUiStatus("disconnecting");
    setConfirmDisconnect(false);

    try {
      const res = await fetch(`/api/v1/companies/${slug}/buffer/disconnect`, { method: "POST" });
      if (!res.ok) throw new Error();
      setConnection({ connected: false, bufferUserId: null, connectedAt: null });
      setUiStatus("idle");
    } catch {
      setUiStatus("error");
    }
  }

  return (
    <Card className="px-6 py-6">
      {bufferParam === "connected" && (
        <Alert variant="success" className="mb-5">
          {t("successConnected")}
        </Alert>
      )}
      {bufferParam === "error" && (
        <Alert variant="error" className="mb-5">
          {t("connectError")}
        </Alert>
      )}
      {uiStatus === "error" && (
        <Alert variant="error" className="mb-5">
          {t("disconnectError")}
        </Alert>
      )}

      <div className="flex items-start gap-4">
        <BufferIcon />

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center justify-between gap-4">
            <h2 className="text-fg text-sm font-semibold">{t("bufferIntegration")}</h2>
            <Badge variant={connected ? "success" : "neutral"}>
              {connected ? t("connected") : t("notConnected")}
            </Badge>
          </div>

          <p className="text-fg-muted mb-4 text-sm leading-relaxed">{t("connectDesc")}</p>

          {connected && (
            <dl className="mb-4 space-y-1.5">
              <div className="flex items-center gap-2 text-sm">
                <dt className="text-fg-muted">{t("bufferUserId")}</dt>
                <dd className="text-fg font-medium">{connection.bufferUserId}</dd>
              </div>
              {connection.connectedAt && (
                <div className="flex items-center gap-2 text-sm">
                  <dt className="text-fg-muted">{t("connectedSince")}</dt>
                  <dd className="text-fg">
                    {new Date(connection.connectedAt).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </dd>
                </div>
              )}
            </dl>
          )}

          {!canManage && <p className="text-fg-muted mb-3 text-xs">{t("ownersOnly")}</p>}

          {canManage && !connected && (
            <Button variant="primary" onClick={handleConnect}>
              {t("connectBuffer")}
            </Button>
          )}

          {canManage && connected && !confirmDisconnect && (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" onClick={handleConnect}>
                {t("reconnect")}
              </Button>
              <Button variant="danger" onClick={() => setConfirmDisconnect(true)}>
                {t("disconnect")}
              </Button>
            </div>
          )}

          {canManage && confirmDisconnect && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-fg-muted text-sm">{t("areYouSure")}</span>
              <Button
                variant="danger"
                loading={uiStatus === "disconnecting"}
                onClick={handleDisconnect}
              >
                {uiStatus === "disconnecting" ? t("disconnecting") : t("yesDisconnect")}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>
                {tCommon("cancel")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
