"use client";

import { useRouter, usePathname } from "next/navigation";
import { useTransition, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { MediaCard } from "./media-card";
import type { MediaItem } from "@/lib/services/company/list-media.service";

interface Props {
  slug: string;
  items: MediaItem[];
  total: number;
  page: number;
  pageSize: number;
  channel: string;
  provider: string;
  sort: string;
  canDelete: boolean;
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
  items: initialItems,
  total: initialTotal,
  page,
  pageSize,
  channel,
  provider,
  sort,
  canDelete,
}: Props) {
  const t = useTranslations("mediaGallery");
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [items, setItems] = useState<MediaItem[]>(initialItems);
  const [total, setTotal] = useState(initialTotal);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const CHANNEL_FILTERS = [
    { value: "", label: t("allChannels") },
    { value: "facebook", label: "Facebook" },
    { value: "linkedin", label: "LinkedIn" },
    { value: "instagram", label: "Instagram" },
    { value: "tiktok", label: "TikTok" },
  ] as const;

  const PROVIDER_FILTERS = [
    { value: "", label: t("allProviders") },
    { value: "leonardo", label: "Leonardo" },
    { value: "mock", label: "Mock" },
  ] as const;

  const SORT_OPTIONS = [
    { value: "newest", label: t("newestFirst") },
    { value: "oldest", label: t("oldestFirst") },
  ] as const;

  function handleDeleted(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
    setTotal((prev) => Math.max(0, prev - 1));
  }

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
            {t("channelLabel")}
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
            {t("providerLabel")}
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
          <span className="text-xs font-semibold tracking-wider text-gray-400 uppercase">
            {t("sortLabel")}
          </span>
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
          {t("imageCount", { count: total })}
          {channel || provider ? t("matchingFilters") : ""}
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
            title={t("noImages")}
            description={channel || provider ? t("noImagesFilter") : t("noImagesDesc")}
            action={
              !channel && !provider ? (
                <Link
                  href={`/companies/${slug}`}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-green-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-600"
                >
                  {t("generateFirst")}
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {isPending
              ? Array.from({ length: pageSize }).map((_, i) => <SkeletonCard key={i} />)
              : items.map((item) => (
                  <MediaCard
                    key={item.id}
                    item={item}
                    slug={slug}
                    canDelete={canDelete}
                    onDeleted={handleDeleted}
                  />
                ))}
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
            {t("previousPage")}
          </Button>
          <span className="text-sm text-gray-500">{t("page", { page, total: totalPages })}</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= totalPages || isPending}
            onClick={() => navigate({ page: page + 1 })}
          >
            {t("nextPage")}
          </Button>
        </div>
      )}
    </div>
  );
}
