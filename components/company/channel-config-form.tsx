import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type {
  ChannelConfigItem,
  PostingWindow,
} from "@/lib/services/company/list-channel-configs.service";

export interface ChannelFormPayload {
  enabled: boolean;
  bufferProfileId: string | null;
  postsPerDay: number;
  postsPerWeek: number;
  language: "en" | "bg";
  imageRequired: boolean;
  automationModeOverride: "semi_automated" | "fully_automated" | null;
  postingWindows: PostingWindow[];
}

interface Props {
  initialConfig: ChannelConfigItem;
  saving: boolean;
  onSave: (data: ChannelFormPayload) => void;
  onCancel: () => void;
}

const BASE =
  "w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none transition-all duration-200 focus:ring-2 focus:ring-offset-0";
const NORMAL = "border-gray-300 bg-white focus:border-green-500 focus:ring-green-100";

function formatWindows(windows: PostingWindow[]): string {
  return windows.map((w) => `${w.day} ${w.start}-${w.end}`).join("\n");
}

function parseWindows(text: string): PostingWindow[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const m = line
        .toUpperCase()
        .match(
          /^(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/
        );
      if (!m) return [];
      return [{ day: m[1], start: m[2], end: m[3] }];
    });
}

export function ChannelConfigForm({ initialConfig, saving, onSave, onCancel }: Props) {
  const [enabled, setEnabled] = useState(initialConfig.enabled);
  const [bufferProfileId, setBufferProfileId] = useState(initialConfig.bufferProfileId ?? "");
  const [postsPerDay, setPostsPerDay] = useState(String(initialConfig.postsPerDay));
  const [postsPerWeek, setPostsPerWeek] = useState(String(initialConfig.postsPerWeek));
  const [language, setLanguage] = useState<"en" | "bg">(
    initialConfig.postingLanguage === "bg" ? "bg" : "en"
  );
  const [imageRequired, setImageRequired] = useState(initialConfig.imageRequired);
  const [automationOverride, setAutomationOverride] = useState<string>(
    initialConfig.automationModeOverride ?? ""
  );
  const [windowsText, setWindowsText] = useState(formatWindows(initialConfig.postingWindows));

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      enabled,
      bufferProfileId: bufferProfileId.trim() || null,
      postsPerDay: Math.max(0, Math.min(20, parseInt(postsPerDay, 10) || 0)),
      postsPerWeek: Math.max(0, Math.min(100, parseInt(postsPerWeek, 10) || 0)),
      language,
      imageRequired,
      automationModeOverride:
        automationOverride === "semi_automated" || automationOverride === "fully_automated"
          ? automationOverride
          : null,
      postingWindows: parseWindows(windowsText),
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {/* Enabled */}
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-green-500 focus:ring-green-500"
        />
        <span className="text-sm font-medium text-gray-700">Enabled</span>
      </label>

      {/* Row: posts/day + posts/week */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">Posts per day</label>
          <input
            type="number"
            min={0}
            max={20}
            value={postsPerDay}
            onChange={(e) => setPostsPerDay(e.target.value)}
            className={`${BASE} ${NORMAL}`}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">Posts per week</label>
          <input
            type="number"
            min={0}
            max={100}
            value={postsPerWeek}
            onChange={(e) => setPostsPerWeek(e.target.value)}
            className={`${BASE} ${NORMAL}`}
          />
        </div>
      </div>

      {/* Row: language + automation override */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">Language</label>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as "en" | "bg")}
            className={`${BASE} ${NORMAL}`}
          >
            <option value="en">EN — English</option>
            <option value="bg">BG — Bulgarian</option>
          </select>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">Automation mode</label>
          <select
            value={automationOverride}
            onChange={(e) => setAutomationOverride(e.target.value)}
            className={`${BASE} ${NORMAL}`}
          >
            <option value="">Company default</option>
            <option value="semi_automated">Semi-automated</option>
            <option value="fully_automated">Fully automated</option>
          </select>
        </div>
      </div>

      {/* Image required */}
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={imageRequired}
          onChange={(e) => setImageRequired(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-green-500 focus:ring-green-500"
        />
        <span className="text-sm font-medium text-gray-700">Image required</span>
      </label>

      {/* Buffer Profile ID */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-gray-700">
          Buffer Profile ID <span className="font-normal text-gray-400">(optional)</span>
        </label>
        <input
          type="text"
          value={bufferProfileId}
          onChange={(e) => setBufferProfileId(e.target.value)}
          placeholder="e.g. 56d0e1b43d922b506041c12c"
          className={`${BASE} ${NORMAL}`}
        />
      </div>

      {/* Posting windows */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-gray-700">
          Posting windows{" "}
          <span className="font-normal text-gray-400">(one per line: MONDAY 09:00-17:00)</span>
        </label>
        <textarea
          rows={4}
          value={windowsText}
          onChange={(e) => setWindowsText(e.target.value)}
          placeholder={"MONDAY 09:00-17:00\nTUESDAY 09:00-17:00"}
          className={`${BASE} ${NORMAL} resize-none`}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
