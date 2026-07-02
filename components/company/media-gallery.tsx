"use client";

import { useRouter, usePathname } from "next/navigation";
import { useTransition } from "react";
import Link from "next/link";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { MediaCard } from "./media-card";
import type { MediaItem } from "@/lib/services/company/list-media.service";

const CHANNEL_FILTERS = [
  { value: "", label: "All Channels" },
  { value: "facebook", label: "Facebook" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
] as const;

const PROVIDER_FILTERS = [
  { value: "", label: "All Providers" },
  { value: "leonardo", label: "Leonardo" },
  { value: "mock", label: "Mock" },
] as const;

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
] as const;

interface Props {
  slug: string;
  items: MediaItem[];
  total: number;
  page: number;
  pageSize: number;
  channel: string;
  provider: string;
  sort: string;
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors duration-150",
        active ? "bg-green-500 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function SkeletonCard() {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="aspect-video w-full animate-pulse bg-gray-200" />
      <div className="space-y-3 px-4 py-4">
        <div className="flex gap-2">
          <div className="h-5 w-20 animate-pulse rounded-full bg-gray-200" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-gray-200" />
        </div>
        <div className="h-3 w-24 animate-pulse rounded bg-gray-200" />
        <div className="h-3 w-32 animate-pulse rounded bg-gray-200" />
      </div>
    </div>
  );
}

export function MediaGallery({
  slug,
  items,
  total,
  page,
  pageSize,
  channel,
  provider,
  sort,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function navigate(
    updates: Partial<{ channel: string; provider: string; sort: string; page: number }>
  ) {
    const params = new URLSearchParams();
    const nextChannel = updates.channel !== undefined ? updates.channel : channel;
    const nextProvider = updates.provider !== undefined ? updates.provider : provider;
    const nextSort = updates.sort !== undefined ? updates.sort : sort;
    const nextPage = updates.page !== undefined ? updates.page : 1;

    if (nextChannel) params.set("channel", nextChannel);
    if (nextProvider) params.set("provider", nextProvider);
    if (nextSort && nextSort !== "newest") params.set("sort", nextSort);
    if (nextPage > 1) params.set("page", String(nextPage));
    if (pageSize !== 24) params.set("pageSize", String(pageSize));

    const qs = params.toString();
    startTransition(() => {
      router.push(`${pathname}${qs ? `?${qs}` : ""}`);
    });
  }

  return (
    <div className="space-y-6">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
        {/* Channel pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-semibold tracking-wider text-gray-400 uppercase">
            Channel
          </span>
          {CHANNEL_FILTERS.map((f) => (
            <FilterPill
              key={f.value}
              active={channel === f.value}
              onClick={() => navigate({ channel: f.value })}
            >
              {f.label}
            </FilterPill>
          ))}
        </div>

        {/* Provider pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-semibold tracking-wider text-gray-400 uppercase">
            Provider
          </span>
          {PROVIDER_FILTERS.map((f) => (
            <FilterPill
              key={f.value}
              active={provider === f.value}
              onClick={() => navigate({ provider: f.value })}
            >
              {f.label}
            </FilterPill>
          ))}
        </div>

        {/* Sort */}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs font-semibold tracking-wider text-gray-400 uppercase">Sort</span>
          <select
            value={sort || "newest"}
            onChange={(e) => navigate({ sort: e.target.value })}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium outline-none focus:border-green-500 focus:ring-2 focus:ring-green-100"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Count */}
      {total > 0 && (
        <p className="text-sm text-gray-500">
          {total} {total === 1 ? "image" : "images"}
          {channel || provider ? " matching filters" : ""}
        </p>
      )}

      {/* Grid — dimmed during navigation */}
      <div
        className={
          isPending ? "pointer-events-none opacity-50 transition-opacity" : "transition-opacity"
        }
      >
        {items.length === 0 ? (
          <EmptyState
            icon="🖼️"
            title="No generated images yet."
            description={
              channel || provider
                ? "Try adjusting your filters."
                : "Generate your first image from a draft post."
            }
            action={
              !channel && !provider ? (
                <Link
                  href={`/companies/${slug}`}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-green-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-600"
                >
                  Generate your first image
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {isPending
              ? Array.from({ length: pageSize }).map((_, i) => <SkeletonCard key={i} />)
              : items.map((item) => <MediaCard key={item.id} item={item} slug={slug} />)}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-4">
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1 || isPending}
            onClick={() => navigate({ page: page - 1 })}
          >
            ← Previous
          </Button>
          <span className="text-sm text-gray-500">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= totalPages || isPending}
            onClick={() => navigate({ page: page + 1 })}
          >
            Next →
          </Button>
        </div>
      )}
    </div>
  );
}
