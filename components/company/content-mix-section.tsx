"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import type { ContentMixDTO } from "@/lib/services/company/get-content-mix.service";
import { CONTENT_MIX_ANCHOR } from "@/lib/posts/bulk-draft";

const BASE =
  "rounded-control border px-3 py-1.5 text-sm outline-none transition-all duration-fast focus:ring-2 focus:ring-offset-0";
const NORMAL = "border-border-strong bg-surface focus:border-accent focus:ring-accent/20";
const INVALID = "border-status-danger-dot bg-surface focus:border-status-danger-dot";

interface Props {
  slug: string;
  initialMix: ContentMixDTO;
  canManage: boolean;
  /**
   * Where the user came from and should be offered back to — set only when this
   * page was opened from the bulk generation form. Null on an ordinary visit to
   * settings, which then looks and behaves exactly as it always has.
   */
  returnHref?: string | null;
}

/** Quota inputs are held as strings so a field can be emptied while typing. */
type Draft = Record<string, string>;

/** Sentinel key for the company-content row; sources are keyed by their id. */
const COMPANY_KEY = "__company__";

function toDraft(mix: ContentMixDTO): Draft {
  const draft: Draft = {
    [COMPANY_KEY]: mix.companyContentPostsPerWeek?.toString() ?? "",
  };
  for (const source of mix.sources) {
    if (!source.enabled) continue;
    draft[source.id] = source.postsPerWeek?.toString() ?? "";
  }
  return draft;
}

/** "" → null (no quota). A non-numeric value → null so it reads as unassigned. */
function parseQuota(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * "Which sources do a channel's posts come from?" — the whole feature, and
 * nothing else.
 *
 * This panel used to open on a weekly target the quotas had to hit exactly, a
 * running "remaining" counter, and a warning when two channels posted at
 * different cadences. None of it belongs here: how many posts a channel gets is
 * that channel's own posts-per-week, and this screen only splits that number
 * between sources (see mixForChannel — a 3/1/1 recipe fills a 5-post channel as
 * 3/1/1 and a 7-post one as 4/2/1). So the numbers here answer to nothing but
 * each other, and the screen now says only that.
 *
 * What is left is a list of sources, a number each, and their sum. The feature
 * is optional and the copy leads with it: a company with no mix keeps the
 * pooled behaviour it has always had, which is a perfectly good answer and not
 * a setup step left undone.
 */
export function ContentMixSection({ slug, initialMix, canManage, returnHref = null }: Props) {
  const t = useTranslations("contentMix");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();

  const [mix, setMix] = useState(initialMix);
  const [draft, setDraft] = useState<Draft>(() => toDraft(initialMix));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const enabledSources = useMemo(() => mix.sources.filter((s) => s.enabled), [mix.sources]);

  const sectionRef = useRef<HTMLDivElement>(null);

  /**
   * Arriving from the bulk form lands ON the editor, not at the top of a
   * settings page with it somewhere below.
   *
   * The `#content-mix` anchor already scrolls; this repeats it because the panel
   * is the last thing on a long page whose height settles as it hydrates, which
   * is exactly when a browser's own anchor scroll lands short. Moving focus here
   * as well is the part the anchor cannot do: it puts the keyboard where the
   * user was sent and gives a screen reader something to announce.
   */
  useEffect(() => {
    if (!returnHref) return;
    const section = sectionRef.current;
    if (!section) return;
    section.scrollIntoView({ block: "start", behavior: "smooth" });
    section.focus({ preventScroll: true });
  }, [returnHref]);

  const total = useMemo(() => {
    let sum = parseQuota(draft[COMPANY_KEY]) ?? 0;
    for (const source of enabledSources) sum += parseQuota(draft[source.id]) ?? 0;
    return sum;
  }, [draft, enabledSources]);

  const configured = useMemo(
    () =>
      parseQuota(draft[COMPANY_KEY]) !== null ||
      enabledSources.some((s) => parseQuota(draft[s.id]) !== null),
    [draft, enabledSources]
  );

  const unassigned = useMemo(
    () => configured && enabledSources.some((s) => parseQuota(draft[s.id]) === null),
    [configured, draft, enabledSources]
  );

  // The two rules the server still enforces, in the order it checks them: every
  // enabled source needs a number, and the week has a ceiling. A mix of all
  // zeros is the third — it would generate nothing, and "Clear mix" is the way
  // to say that.
  const problem: string | null = unassigned
    ? apiError({ code: "MIX_SOURCE_UNASSIGNED" })
    : configured && total === 0
      ? apiError({ code: "MIX_EMPTY" })
      : total > mix.maxPostsPerWeek
        ? apiError({ code: "MIX_EXCEEDS_MAX" })
        : null;

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(toDraft(mix)), [draft, mix]);

  // An unconfigured mix is always saveable — it is the "clear the mix" action.
  const canSave = canManage && dirty && !saving && (!configured || problem === null);

  function setValue(key: string, value: string) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
    setError("");
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const res = await fetch(`/api/v1/companies/${slug}/content-mix`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sources: enabledSources.map((s) => ({
            sourceId: s.id,
            postsPerWeek: parseQuota(draft[s.id]),
          })),
          companyContentPostsPerWeek: parseQuota(draft[COMPANY_KEY]),
        }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { code?: string; message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { mix: ContentMixDTO };
      setMix(json.mix);
      setDraft(toDraft(json.mix));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setSaving(false);
    }
  }

  function handleClear() {
    const cleared: Draft = { [COMPANY_KEY]: "" };
    for (const source of enabledSources) cleared[source.id] = "";
    setDraft(cleared);
    setSaved(false);
    setError("");
  }

  // Company content sits last: it is a source like the others here, just one
  // that never runs out of material.
  const rows: Array<{ key: string; label: string }> = [
    ...enabledSources.map((s) => ({ key: s.id, label: s.name })),
    { key: COMPANY_KEY, label: t("companyContent") },
  ];

  return (
    // Focusable only programmatically (tabIndex -1): it is a scroll-and-announce
    // target for the trip in from generation, never a tab stop of its own.
    <div
      ref={sectionRef}
      id={CONTENT_MIX_ANCHOR}
      tabIndex={-1}
      className="rounded-card border-border bg-surface scroll-mt-24 border px-5 py-5 shadow-sm outline-none"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-fg text-sm font-semibold">{t("title")}</h3>
        <span className="rounded-control border-border text-fg-muted border px-1.5 py-0.5 text-[11px] font-medium">
          {t("optional")}
        </span>
        {/* The way back, at the top where someone who has just arrived will look
            for it. A batch is waiting on the other end, exactly as it was left. */}
        {returnHref && (
          <Link
            href={returnHref}
            className="text-accent ml-auto inline-flex items-center gap-1 text-xs font-semibold underline underline-offset-2"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            {t("backToGeneration")}
          </Link>
        )}
      </div>
      <p className="text-fg-muted mt-1 text-xs">{t("description")}</p>

      <div className="mt-4 flex justify-end">
        <span className="text-fg-faint text-xs">{t("postsPerWeek")}</span>
      </div>

      <div className="mt-1 space-y-2">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-3">
            <span className="text-fg min-w-0 flex-1 truncate text-sm">{row.label}</span>
            {/* Dotted leader, as in the spec's sketch. */}
            <span
              aria-hidden="true"
              className="border-border min-w-6 flex-1 border-b border-dotted"
            />
            <input
              type="number"
              min={0}
              max={mix.maxPostsPerWeek}
              inputMode="numeric"
              aria-label={row.label}
              placeholder={t("unassigned")}
              disabled={!canManage || saving}
              value={draft[row.key] ?? ""}
              onChange={(e) => setValue(row.key, e.target.value)}
              className={`${BASE} ${
                configured && parseQuota(draft[row.key]) === null ? INVALID : NORMAL
              } w-24 text-right disabled:opacity-60`}
            />
          </div>
        ))}
      </div>

      <div className="border-border mt-4 flex items-baseline justify-between border-t pt-3">
        <span className="text-fg-muted text-sm font-medium">{t("total")}</span>
        <span className="text-fg text-sm font-semibold">{t("postsCount", { count: total })}</span>
      </div>

      {problem && <p className="text-status-danger-dot mt-2 text-xs">{problem}</p>}

      {/* The one thing this screen must not be mistaken for: a second weekly
          target. Each channel keeps its own, and these numbers only split it. */}
      <p className="text-fg-faint mt-3 text-xs">{t("channelNote")}</p>
      <p className="text-fg-faint mt-1 text-xs">{t("autoNote")}</p>

      {/* A mix stored before this company's sources changed can be invalid on
          load — an added source with no quota is the realistic case. */}
      {mix.validationError && !dirty && (
        <Alert variant="warning" className="mt-4">
          {apiError({ code: mix.validationError.code })}
        </Alert>
      )}

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}

      {saved && (
        <Alert variant="success" className="mt-4">
          {t("saved")}
        </Alert>
      )}

      {canManage ? (
        <div className="mt-4 flex gap-2">
          <Button variant="primary" size="sm" disabled={!canSave} onClick={handleSave}>
            {saving ? t("saving") : t("save")}
          </Button>
          {dirty && (
            <Button
              variant="secondary"
              size="sm"
              disabled={saving}
              onClick={() => setDraft(toDraft(mix))}
            >
              {t("reset")}
            </Button>
          )}
          {configured && (
            <Button variant="secondary" size="sm" disabled={saving} onClick={handleClear}>
              {t("clear")}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-fg-faint mt-4 text-xs">{t("ownersOnly")}</p>
      )}
    </div>
  );
}
