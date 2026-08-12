"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/Alert";
import { formatDateTime } from "@/lib/i18n/format-date";
import { bulkOutcome, partialReasonKey, type BulkBatchResponse } from "@/lib/posts/bulk-form";

interface Props {
  batch: BulkBatchResponse;
  locale: string;
}

/**
 * What a finished bulk run actually produced.
 *
 * A batch can legitimately come back short — the source pool runs dry, the
 * generator cannot find a sufficiently different angle, or the request runs out
 * of time before the last slots are attempted. All three are normal outcomes
 * with real posts attached, so this reports rather than apologises: how many
 * were asked for, how many exist, how many do not, and why.
 *
 * A run that produced NOTHING never reaches here — the API returns that as an
 * error with the generation's own code, and the form shows it exactly as it
 * shows a failed single generation.
 */
export function BulkResultSummary({ batch, locale }: Props) {
  const t = useTranslations("posts.generate.bulk");
  const outcome = bulkOutcome(batch);
  const missing = batch.requested - batch.generated;

  return (
    <Alert variant={outcome === "complete" ? "success" : "warning"} className="mb-4">
      <div className="space-y-1.5">
        <p className="font-medium">
          {outcome === "complete"
            ? t("resultComplete", { generated: batch.generated })
            : t("resultPartial", { generated: batch.generated, requested: batch.requested })}
        </p>

        {outcome === "partial" && (
          <>
            <p className="text-xs">{t("resultCounts", { missing, requested: batch.requested })}</p>
            {/* Named, not summarised: "no new articles" and "we ran out of
                request time" call for completely different next steps. */}
            <p className="text-xs">{t(partialReasonKey(batch))}</p>
          </>
        )}

        {/* A source ran dry and the others covered for it. Worth saying even on
            a complete run: the batch matched the mix that was asked for, but not
            the one that was written, and the next run may be short if nothing
            new arrives. */}
        {batch.exhaustedSources.length > 0 && (
          <p className="text-xs">
            {t("resultMixTransferred", { count: batch.exhaustedSources.length })}
          </p>
        )}

        {batch.posts.length > 0 && (
          <p className="text-xs">
            {t("resultScheduledRange", {
              first: formatDateTime(batch.posts[0].scheduledFor, locale),
              last: formatDateTime(batch.posts[batch.posts.length - 1].scheduledFor, locale),
            })}
          </p>
        )}

        <p className="text-xs">{t("resultReviewNote")}</p>
      </div>
    </Alert>
  );
}
