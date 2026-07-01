import { Alert } from "@/components/ui/Alert";
import { ChannelConfigCard } from "./channel-config-card";
import type { ChannelConfigItem } from "@/lib/services/company/list-channel-configs.service";

interface Props {
  slug: string;
  initialConfigs: ChannelConfigItem[];
  canManage: boolean;
  bufferConnected: boolean;
}

export function ChannelConfigSection({ slug, initialConfigs, canManage, bufferConnected }: Props) {
  return (
    <div className="space-y-4">
      {!bufferConnected && (
        <Alert variant="warning">Connect Buffer before assigning Buffer profile IDs.</Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {initialConfigs.map((config) => (
          <ChannelConfigCard
            key={config.channel}
            slug={slug}
            initialConfig={config}
            canManage={canManage}
          />
        ))}
      </div>
    </div>
  );
}
