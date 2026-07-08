import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/Alert";
import { ChannelConfigCard } from "./channel-config-card";
import type { ChannelConfigItem } from "@/lib/services/company/list-channel-configs.service";

interface Props {
  slug: string;
  initialConfigs: ChannelConfigItem[];
  canManage: boolean;
  bufferConnected: boolean;
  companyAutomationMode: "semi_automated" | "fully_automated";
}

export function ChannelConfigSection({
  slug,
  initialConfigs,
  canManage,
  bufferConnected,
  companyAutomationMode,
}: Props) {
  const t = useTranslations("channels");
  return (
    <div className="space-y-4">
      {!bufferConnected && <Alert variant="warning">{t("connectBufferFirst")}</Alert>}
      {bufferConnected && initialConfigs.length === 0 && (
        <Alert variant="info">{t("noProfiles")}</Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {initialConfigs.map((config) => (
          <ChannelConfigCard
            key={config.id}
            slug={slug}
            initialConfig={config}
            canManage={canManage}
            companyAutomationMode={companyAutomationMode}
          />
        ))}
      </div>
    </div>
  );
}
