"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronRight } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { CopyButton } from "@/components/ui/CopyButton";
import { TraceSection } from "./generation-trace-value";
import { isKnownStepType } from "@/lib/generation-trace/step-types";
import type {
  PostGenerationTraceView,
  TraceRunView,
  TraceStepView,
} from "@/lib/services/admin/get-post-generation-trace.service";

/**
 * A post's generation, as a readable vertical timeline.
 *
 * ── Two views, for two questions ────────────────────────────────────────────
 *
 * **Overview** answers "what happened, in order, and where did it go wrong" —
 * every step as a compact header (name, status, duration) that expands into the
 * detail it captured. Steps that did not occur are simply absent: a post written
 * from a manually entered prompt shows no translation step, rather than an empty
 * one implying an RSS pipeline it never went through. A step that says *skipped*
 * is a stage that was genuinely reached and declined.
 *
 * **Raw Debug** answers "give me everything" — the stored trace as JSON, with
 * one Copy action, for pasting into a ticket or another tool.
 *
 * ── Failed attempts are the point ───────────────────────────────────────────
 *
 * A run that took three tries shows all three, each with the prompt it was given
 * and the reply it produced. Rejected attempts are grouped under their number so
 * a reader can see the correction the next prompt carried — which is the one
 * thing a "final prompt only" record could never show.
 */

interface Props {
  postId: string;
  open: boolean;
  onClose: () => void;
}

type Tab = "overview" | "raw";

export function GenerationTraceModal({ postId, open, onClose }: Props) {
  const t = useTranslations("generationTrace");
  const tCommon = useTranslations("common");

  const [trace, setTrace] = useState<PostGenerationTraceView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/v1/admin/posts/${postId}/generation-trace`);
        if (cancelled) return;
        if (!res.ok) throw new Error(tCommon("somethingWentWrong"));
        const json = (await res.json()) as { trace: PostGenerationTraceView };
        if (!cancelled) setTrace(json.trace);
      } catch (err: unknown) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [open, postId, tCommon]);

  const hasRuns = (trace?.runs.length ?? 0) > 0;

  return (
    <Modal open={open} onClose={onClose} title={t("title")} maxWidth="5xl">
      <p className="text-fg-muted mb-4 text-sm">{t("subtitle")}</p>

      {loading ? (
        <p className="text-fg-faint py-10 text-center text-sm">{t("loading")}</p>
      ) : error ? (
        <p className="text-status-danger-dot py-10 text-center text-sm">{error}</p>
      ) : !hasRuns ? (
        <div className="py-10 text-center">
          <p className="text-fg text-sm">{t("empty")}</p>
          <p className="text-fg-faint mx-auto mt-1 max-w-md text-xs">{t("emptyHint")}</p>
        </div>
      ) : (
        <>
          <div className="border-border mb-4 flex gap-1 border-b">
            {(["overview", "raw"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                aria-current={tab === value ? "true" : undefined}
                className={[
                  "focus-ring duration-fast -mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                  tab === value
                    ? "border-accent text-fg font-medium"
                    : "text-fg-muted hover:text-fg border-transparent",
                ].join(" ")}
              >
                {t(`tabs.${value}`)}
              </button>
            ))}
          </div>

          {tab === "overview" ? (
            <div className="space-y-6">
              {trace!.runs.map((run) => (
                <RunPanel key={run.id} run={run} linkedRuns={trace!.linkedRuns} />
              ))}
            </div>
          ) : (
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-fg-faint text-xs">{t("rawHint")}</p>
                <CopyButton value={JSON.stringify(trace, null, 2)} />
              </div>
              <pre className="rounded-control border-border bg-surface-subtle text-fg max-h-[60vh] overflow-auto border p-3 font-mono text-xs whitespace-pre">
                {JSON.stringify(trace, null, 2)}
              </pre>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ─── One run ──────────────────────────────────────────────────────────────────

function RunPanel({
  run,
  linkedRuns,
}: {
  run: TraceRunView;
  linkedRuns: Record<string, TraceRunView>;
}) {
  const t = useTranslations("generationTrace");
  // Failures open themselves: a reader who opens a trace on a failed run is
  // there for the failure, and making them click again to find it is rude.
  const [allOpen, setAllOpen] = useState<boolean | null>(null);

  return (
    <section className="rounded-panel border-border border">
      <header className="border-border bg-surface-subtle rounded-t-panel border-b px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-fg text-sm font-semibold">{t(`kind.${run.kind}`)}</h3>
            <RunStatusPill status={run.status} />
            <span className="text-fg-faint text-xs">{t(`trigger.${run.trigger}`)}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAllOpen(true)}
              className="text-fg-faint hover:text-fg text-xs underline underline-offset-2"
            >
              {t("expandAll")}
            </button>
            <button
              type="button"
              onClick={() => setAllOpen(false)}
              className="text-fg-faint hover:text-fg text-xs underline underline-offset-2"
            >
              {t("collapseAll")}
            </button>
          </div>
        </div>

        <RunSummary run={run} />

        {run.truncated && (
          <p className="text-status-warning-fg bg-status-warning-bg rounded-control mt-2 px-2 py-1 text-xs">
            {t("truncatedWarning")}
          </p>
        )}

        {run.errorCode && (
          <p className="text-status-danger-fg bg-status-danger-bg rounded-control mt-2 px-2 py-1 text-xs">
            <span className="font-mono font-semibold">{run.errorCode}</span>
            {run.errorMessage ? ` — ${run.errorMessage}` : ""}
          </p>
        )}
      </header>

      <ol className="divide-border divide-y">
        {run.steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            linkedRun={step.linkedRunId ? (linkedRuns[step.linkedRunId] ?? null) : null}
            forceOpen={allOpen}
          />
        ))}
      </ol>
    </section>
  );
}

function RunSummary({ run }: { run: TraceRunView }) {
  const t = useTranslations("generationTrace");

  const facts: Array<[string, string | null]> = [
    [t("summary.requestedBy"), run.requestedBy?.email ?? t("summary.automated")],
    [t("summary.channel"), run.channel],
    [t("summary.language"), run.language],
    [
      t("summary.model"),
      run.llmProvider ? `${run.llmProvider}${run.llmModel ? ` · ${run.llmModel}` : ""}` : null,
    ],
    [t("summary.attempts"), run.attempts > 0 ? String(run.attempts) : null],
    [t("summary.duration"), formatDuration(run.durationMs)],
    [t("summary.startedAt"), new Date(run.startedAt).toLocaleString()],
    [t("summary.steps"), String(run.steps.length)],
    [t("summary.contentGroupId"), run.contentGroupId],
    [t("summary.batchId"), run.generationBatchId],
    [t("summary.scheduleId"), run.scheduleId],
    [t("summary.jobId"), run.jobId],
  ];

  return (
    <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
      {facts
        .filter(([, value]) => value !== null && value !== "")
        .map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-1.5">
            <dt className="text-fg-faint text-xs">{label}</dt>
            <dd className="text-fg font-mono text-xs break-all">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

// ─── One step ─────────────────────────────────────────────────────────────────

const DOT: Record<TraceStepView["status"], string> = {
  success: "bg-status-success-dot",
  failed: "bg-status-danger-dot",
  skipped: "bg-fg-faint",
};

function StepRow({
  step,
  linkedRun,
  forceOpen,
}: {
  step: TraceStepView;
  linkedRun: TraceRunView | null;
  forceOpen: boolean | null;
}) {
  const t = useTranslations("generationTrace");
  const [open, setOpen] = useState(step.status === "failed");
  const [lastForce, setLastForce] = useState<boolean | null>(forceOpen);

  // Expand/collapse-all wins over the local toggle the moment it is pressed, and
  // then hands control back — the same adjust-during-render pattern the posts
  // grid uses for a fresh server list.
  if (forceOpen !== lastForce) {
    setLastForce(forceOpen);
    if (forceOpen !== null) setOpen(forceOpen);
  }

  const typeLabel = isKnownStepType(step.type) ? t(`stepType.${step.type}`) : t("stepType.unknown");

  const hasBody =
    step.input !== null ||
    step.output !== null ||
    step.metadata !== null ||
    step.errorMessage !== null ||
    linkedRun !== null;

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!hasBody}
        aria-expanded={open}
        className="focus-ring hover:bg-surface-subtle duration-fast flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors disabled:cursor-default"
      >
        <ChevronRight
          className={`text-fg-faint h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""} ${hasBody ? "" : "opacity-0"}`}
          aria-hidden
        />
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[step.status]}`} aria-hidden />
        <span className="text-fg min-w-0 flex-1 text-sm">
          <span className="font-medium">{typeLabel}</span>
          {step.label && <span className="text-fg-muted"> · {step.label}</span>}
        </span>
        {step.attempt !== null && (
          <span className="rounded-control bg-surface-subtle text-fg-faint shrink-0 px-1.5 py-0.5 text-xs">
            {t("attempt", { n: step.attempt })}
          </span>
        )}
        <span className="text-fg-faint shrink-0 font-mono text-xs">
          {formatDuration(step.durationMs) ?? ""}
        </span>
        <span className="text-fg-faint shrink-0 text-xs">{t(`stepStatus.${step.status}`)}</span>
      </button>

      {open && hasBody && (
        <div className="border-border bg-surface space-y-4 border-t px-4 py-4 pl-10">
          {step.errorMessage && (
            <TraceSection title={t("section.error")} value={step.errorMessage} />
          )}
          <TraceSection title={t("section.input")} value={step.input} />
          <TraceSection title={t("section.output")} value={step.output} />
          <TraceSection title={t("section.metadata")} value={step.metadata} />

          {step.linkedRunId && (
            <div className="rounded-control border-border border border-dashed p-3">
              <p className="text-fg-muted mb-2 text-xs">
                <span className="font-semibold">{t("linked.label")}: </span>
                {linkedRun ? t("linked.available") : t("linked.missing")}
              </p>
              {linkedRun && <LinkedRun run={linkedRun} />}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * A referenced feed-item run, inlined.
 *
 * Rendered flat rather than through `RunPanel` so it cannot nest another
 * expand-all control inside an already-expanded step — and because what a reader
 * wants from a linked translation is its prompts and its reply, not a second
 * timeline chrome around them.
 */
function LinkedRun({ run }: { run: TraceRunView }) {
  const t = useTranslations("generationTrace");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-fg text-xs font-semibold">{t(`kind.${run.kind}`)}</span>
        <RunStatusPill status={run.status} />
        <span className="text-fg-faint font-mono text-xs">
          {run.llmProvider}
          {run.llmModel ? ` · ${run.llmModel}` : ""}
        </span>
      </div>
      <ol className="divide-border divide-y">
        {run.steps.map((step) => (
          <StepRow key={step.id} step={step} linkedRun={null} forceOpen={null} />
        ))}
      </ol>
    </div>
  );
}

function RunStatusPill({ status }: { status: string }) {
  const t = useTranslations("generationTrace");
  const tone =
    status === "failed"
      ? "bg-status-danger-bg text-status-danger-fg"
      : status === "completed"
        ? "bg-status-success-bg text-status-success-fg"
        : "bg-status-neutral-bg text-status-neutral-fg";
  return (
    <span className={`rounded-control px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      {t(`runStatus.${status}`)}
    </span>
  );
}

/** Milliseconds as something a person reads: `840ms`, `2.4s`, `1m 12s`. */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
