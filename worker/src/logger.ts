/** Minimal structured logger — one JSON line per event, scope-tagged. */

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(
  scope: string,
  sink: (line: string) => void = (line) => console.log(line)
): Logger {
  const emit = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg,
      ...(meta ? { meta } : {}),
    };
    sink(JSON.stringify(entry));
  };

  return {
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
  };
}
