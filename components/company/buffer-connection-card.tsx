"use client";

import { useState } from "react";
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
          Buffer account connected successfully.
        </Alert>
      )}
      {bufferParam === "error" && (
        <Alert variant="error" className="mb-5">
          Unable to connect Buffer account. Please try again.
        </Alert>
      )}
      {uiStatus === "error" && (
        <Alert variant="error" className="mb-5">
          Failed to disconnect Buffer. Please try again.
        </Alert>
      )}

      <div className="flex items-start gap-4">
        <BufferIcon />

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center justify-between gap-4">
            <h2 className="text-sm font-semibold text-gray-900">Buffer Integration</h2>
            <Badge variant={connected ? "success" : "neutral"}>
              {connected ? "Connected" : "Not Connected"}
            </Badge>
          </div>

          <p className="mb-4 text-sm leading-relaxed text-gray-500">
            Connect your Buffer account to publish AI-generated posts to your social media channels.
          </p>

          {connected && (
            <dl className="mb-4 space-y-1.5">
              <div className="flex items-center gap-2 text-sm">
                <dt className="text-gray-500">Buffer User ID</dt>
                <dd className="font-medium text-gray-900">{connection.bufferUserId}</dd>
              </div>
              {connection.connectedAt && (
                <div className="flex items-center gap-2 text-sm">
                  <dt className="text-gray-500">Connected</dt>
                  <dd className="text-gray-900">
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

          {!canManage && (
            <p className="mb-3 text-xs text-gray-500">
              Only company owners can manage Buffer integrations.
            </p>
          )}

          {canManage && !connected && (
            <Button variant="primary" onClick={handleConnect}>
              Connect Buffer
            </Button>
          )}

          {canManage && connected && !confirmDisconnect && (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" onClick={handleConnect}>
                Reconnect Buffer
              </Button>
              <Button variant="danger" onClick={() => setConfirmDisconnect(true)}>
                Disconnect
              </Button>
            </div>
          )}

          {canManage && confirmDisconnect && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-gray-700">
                Are you sure you want to disconnect Buffer?
              </span>
              <Button
                variant="danger"
                loading={uiStatus === "disconnecting"}
                onClick={handleDisconnect}
              >
                {uiStatus === "disconnecting" ? "Disconnecting…" : "Yes, disconnect"}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
