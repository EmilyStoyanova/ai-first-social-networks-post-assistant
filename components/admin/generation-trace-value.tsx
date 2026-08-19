"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CopyButton } from "@/components/ui/CopyButton";

/**
 * Rendering an arbitrary captured value so a human can actually read it.
 *
 * A trace step's payload is deliberately untyped JSON — each stage captures what
 * it has — so this is where "a prompt", "a similarity score" and "a list of
 * candidate articles" have to become three different-looking things without
 * anybody having declared which is which.
 *
 * The rule is by SHAPE and by SIZE, in that order:
 *
 *   • a scalar is a line of text;
 *   • a short string is a line of text;
 *   • a long or multi-line string is a monospaced block with a Copy action and a
 *     height clamp — this is the prompt/raw-reply case, and it is the reason the
 *     whole component exists;
 *   • a list of scalars is a row of chips, because "which topics matched" reads
 *     as a list and not as JSON;
 *   • anything structural is pretty-printed JSON with a Copy action.
 *
 * Copy always takes the WHOLE value, never the clamped view.
 */

/** Above this, a string gets a block of its own rather than sitting on a line. */
const INLINE_STRING_LIMIT = 140;

export function TraceValue({ value }: { value: unknown }) {
  const t = useTranslations("generationTrace");

  if (value === null || value === undefined || value === "") {
    return <span className="text-fg-faint">{t("noValue")}</span>;
  }

  if (typeof value === "boolean") {
    return <span className="text-data text-fg">{value ? "true" : "false"}</span>;
  }

  if (typeof value === "number") {
    return <span className="text-data text-fg">{value}</span>;
  }

  if (typeof value === "string") {
    if (value.length <= INLINE_STRING_LIMIT && !value.includes("\n")) {
      return <span className="text-fg break-words">{value}</span>;
    }
    return <LongText value={value} />;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-fg-faint">{t("noValue")}</span>;
    // A list of short scalars is a list, not a document.
    const scalars = value.every(
      (item) =>
        item === null ||
        typeof item === "number" ||
        typeof item === "boolean" ||
        (typeof item === "string" && item.length <= 60)
    );
    if (scalars) {
      return (
        <div className="flex flex-wrap gap-1">
          {value.map((item, i) => (
            <span
              key={i}
              className="rounded-control bg-surface-subtle text-fg-muted px-1.5 py-0.5 text-xs"
            >
              {item === null ? "null" : String(item)}
            </span>
          ))}
        </div>
      );
    }
  }

  return <LongText value={JSON.stringify(value, null, 2)} json />;
}

/** A monospaced, clamped, copyable block. */
function LongText({ value, json = false }: { value: string; json?: boolean }) {
  const t = useTranslations("generationTrace");
  const [expanded, setExpanded] = useState(false);
  const lines = value.split("\n").length;
  // Clamped rather than paginated: the point is to see the shape at a glance and
  // open the ones that matter, and a scroll box inside a scrolling modal is a
  // trap for a mouse wheel.
  const needsClamp = lines > 14 || value.length > 1400;

  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-end gap-2">
        <span className="text-fg-faint text-xs">{t("chars", { count: value.length })}</span>
        <CopyButton value={value} />
      </div>
      <pre
        className={[
          "rounded-control border-border bg-surface-subtle text-fg overflow-x-auto border p-2.5 text-xs",
          "font-mono break-words whitespace-pre-wrap",
          needsClamp && !expanded ? "max-h-64 overflow-y-hidden" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {value}
      </pre>
      {needsClamp && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-fg-faint hover:text-fg mt-1 text-xs underline underline-offset-2"
        >
          {expanded ? t("showLess") : t("showMore")}
        </button>
      )}
      {json && <span className="sr-only">JSON</span>}
    </div>
  );
}

/**
 * One captured section (input / output / details) as a definition list.
 *
 * A top-level object becomes one labelled row per key, which is what makes a
 * step readable without opening a JSON blob; anything else is rendered whole.
 */
export function TraceSection({ title, value }: { title: string; value: unknown }) {
  if (value === null || value === undefined) return null;

  const isPlainObject =
    typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;

  return (
    <section className="min-w-0">
      <h4 className="text-fg-muted mb-1.5 text-xs font-semibold tracking-wide uppercase">
        {title}
      </h4>
      {isPlainObject ? (
        <dl className="space-y-2">
          {Object.entries(value as Record<string, unknown>).map(([key, child]) => (
            <div key={key} className="grid gap-1 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
              <dt className="text-fg-faint text-xs break-words">{humanizeKey(key)}</dt>
              <dd className="min-w-0 text-sm">
                <TraceValue value={child} />
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="text-sm">
          <TraceValue value={value} />
        </div>
      )}
    </section>
  );
}

/**
 * `systemPrompt` → "System prompt".
 *
 * Deliberately mechanical rather than a translation table: the keys come from
 * whatever the pipeline captured, a new one appears with every stage added, and
 * a lookup that silently rendered nothing for an unknown key would be worse than
 * a slightly stiff label.
 */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
