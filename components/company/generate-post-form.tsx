"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import type { PostItem } from "@/lib/services/company/list-posts.service";
import type { GenerationWarnings } from "@/lib/services/ai/generate-draft-post.service";

const CHANNELS = [
  { value: "FACEBOOK", label: "Facebook" },
  { value: "LINKEDIN", label: "LinkedIn" },
  { value: "INSTAGRAM", label: "Instagram" },
  { value: "TIKTOK", label: "TikTok" },
] as const;

type Channel = (typeof CHANNELS)[number]["value"];

interface Props {
  slug: string;
  onGenerated: (post: PostItem) => void;
}

export function GeneratePostForm({ slug, onGenerated }: Props) {
  const [channel, setChannel] = useState<Channel>("FACEBOOK");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<GenerationWarnings | null>(null);

  async function handleGenerate() {
    setGenerating(true);
    setError("");
    setWarnings(null);
    try {
      const res = await fetch(`/api/v1/companies/${slug}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(json.error?.message ?? "Generation failed.");
      }
      const json = (await res.json()) as { post: PostItem; warnings: GenerationWarnings };
      onGenerated(json.post);
      if (json.warnings.duplicate.flagged || json.warnings.safety.flagged) {
        setWarnings(json.warnings);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-5 py-5 shadow-sm">
      <h3 className="mb-4 text-sm font-semibold text-gray-900">Generate a draft post</h3>

      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      {warnings?.duplicate.flagged && (
        <Alert variant="warning" className="mb-3">
          Similar post detected (score {warnings.duplicate.similarityScore?.toFixed(2)}). Review
          before publishing.
        </Alert>
      )}

      {warnings?.safety.flagged && (
        <Alert variant="warning" className="mb-3">
          Safety check flagged: {warnings.safety.matchedTerms.join(", ")}. Draft saved — please
          review before approving.
        </Alert>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[160px] flex-1">
          <label
            htmlFor="generate-channel"
            className="mb-1.5 block text-sm font-medium text-gray-700"
          >
            Channel
          </label>
          <select
            id="generate-channel"
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value as Channel);
              setWarnings(null);
            }}
            disabled={generating}
            className="w-full rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm transition-all duration-200 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <Button variant="primary" loading={generating} onClick={handleGenerate}>
          {generating ? "Generating…" : "Generate Draft"}
        </Button>
      </div>
    </div>
  );
}
