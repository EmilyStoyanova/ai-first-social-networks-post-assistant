"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

type Tone = "default" | "success" | "danger";

export interface ToastOptions {
  message: string;
  tone?: Tone;
  /** Optional action, e.g. Undo. Clicking it dismisses the toast. */
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastOptions {
  id: number;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

const AUTO_DISMISS_MS = 5000;

const TONE_ICON: Record<Tone, typeof Info> = {
  default: Info,
  success: CheckCircle2,
  danger: AlertTriangle,
};

const TONE_ICON_COLOR: Record<Tone, string> = {
  default: "text-fg-muted",
  success: "text-status-success-dot",
  danger: "text-status-danger-dot",
};

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  // Auto-dismiss after 5s; hovering pauses the timer (§7 #29).
  const remaining = useRef(AUTO_DISMISS_MS);
  const startedAt = useRef<number>(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const schedule = useCallback(() => {
    startedAt.current = Date.now();
    timer.current = setTimeout(() => onDismiss(item.id), remaining.current);
  }, [item.id, onDismiss]);

  useEffect(() => {
    schedule();
    return clear;
  }, [schedule, clear]);

  function handleMouseEnter() {
    remaining.current -= Date.now() - startedAt.current;
    clear();
  }

  function handleMouseLeave() {
    schedule();
  }

  const Icon = TONE_ICON[item.tone ?? "default"];

  return (
    <div
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="rounded-card animate-panel-in border-border bg-surface pointer-events-auto flex w-80 items-start gap-3 border px-4 py-3 shadow-md"
    >
      <Icon
        className={["mt-0.5 h-4 w-4 shrink-0", TONE_ICON_COLOR[item.tone ?? "default"]].join(" ")}
        aria-hidden
      />
      <p className="text-small text-fg flex-1">{item.message}</p>
      {item.action && (
        <button
          type="button"
          onClick={() => {
            item.action?.onClick();
            onDismiss(item.id);
          }}
          className="text-small focus-ring text-accent shrink-0 font-semibold hover:underline"
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        className="rounded-control focus-ring text-fg-faint duration-fast hover:text-fg shrink-0 p-0.5 transition-colors"
        aria-label="×"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const toast = useCallback((options: ToastOptions) => {
    nextId.current += 1;
    setItems((prev) => [...prev, { ...options, id: nextId.current }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col gap-2"
        aria-live="polite"
        aria-atomic="false"
      >
        {items.map((item) => (
          <ToastCard key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
