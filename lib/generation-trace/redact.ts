/**
 * Making a trace payload safe to store, and small enough to store.
 *
 * A trace captures prompts, provider replies and request metadata verbatim, and
 * verbatim is exactly what makes it useful. It is also what makes it dangerous:
 * an API key, a bearer header or a database URL that reaches this module would
 * be written to a table an admin UI renders in a browser and offers a Copy
 * button for. So nothing is persisted without passing through here first.
 *
 * ── The two rules ───────────────────────────────────────────────────────────
 *
 *  1. A STRING under a secret-sounding key is replaced wholesale. Only strings:
 *     `maxTokens`, `promptTokens` and `tokenUsage.completion` are numbers whose
 *     key matches "token" and which a reader genuinely needs, and a number can
 *     never be a credential. This is what keeps the redactor from quietly
 *     blanking the token accounting the trace exists to show.
 *
 *  2. Any string, under any key, is scanned for credential SHAPES — provider key
 *     prefixes, `Bearer …`, JWTs, and URLs carrying a password or an auth query
 *     parameter. A prompt is a string like any other, and a prompt that somehow
 *     contains a key must not be exempt because its field is called "userPrompt".
 *
 * ── And the size caps ───────────────────────────────────────────────────────
 *
 * Caps are applied in the same pass, because a trace that stores an unbounded
 * provider reply is one bad response away from being the largest row in the
 * database. Everything shortened sets `truncated`, which the run records and the
 * UI shows — a reader must never mistake a capped prompt for the whole one.
 */

export const REDACTED = "[REDACTED]";

/** Per-string cap. Comfortably above a full prompt (~20k) and an article (~12k). */
export const MAX_STRING_CHARS = 40_000;
/** Per-array cap. A candidate window is 5; 200 is room for anything legitimate. */
export const MAX_ARRAY_ITEMS = 200;
/** Per-object cap, guarding against a provider echoing a huge map back. */
export const MAX_OBJECT_KEYS = 200;
/** Recursion cap, which also breaks any cycle a raw provider payload may hold. */
export const MAX_DEPTH = 12;

/**
 * Keys whose STRING values are credentials by name.
 *
 * `token` is included deliberately and is safe because of rule 1 above: a token
 * COUNT is a number and survives, a token VALUE is a string and does not.
 */
const SECRET_KEY = new RegExp(
  [
    "api[-_ ]?key",
    "apikey",
    "secret",
    "password",
    "passwd",
    "\\btoken\\b",
    "accesstoken",
    "refreshtoken",
    "access[-_ ]?token",
    "refresh[-_ ]?token",
    "authorization",
    "auth[-_ ]?header",
    "\\bcookie\\b",
    "set-cookie",
    "credential",
    "bearer",
    "private[-_ ]?key",
    "access[-_ ]?key",
    "client[-_ ]?secret",
    "encryption[-_ ]?key",
    "signing[-_ ]?key",
    "session[-_ ]?id",
    "connection[-_ ]?string",
    "database[-_ ]?url",
    "\\bdsn\\b",
  ].join("|"),
  "i"
);

/**
 * Credential shapes, scanned inside every string.
 *
 * Each pattern is anchored on a prefix or structure that no prose produces by
 * accident, so a legitimate prompt is never mangled: `sk-`/`gsk_`/`xoxb-` key
 * prefixes, a three-segment JWT, `Bearer <blob>`, a URL with inline credentials,
 * and an auth-bearing query parameter.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // OpenAI / Anthropic / Stripe-style prefixed keys.
  /\b(?:sk|rk|pk)-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  // Groq.
  /\bgsk_[A-Za-z0-9]{20,}/g,
  // Slack.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // GitHub.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // `Authorization: Bearer …` and friends, however they were serialized.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi,
  // Inline credentials in a URL: scheme://user:password@host
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi,
  // Auth-bearing query parameters, value only.
  /([?&](?:api[-_]?key|access[-_]?token|token|key|secret|signature|sig|auth)=)[^&\s"']+/gi,
];

export interface SanitizeResult<T> {
  value: T;
  /** True when anything was shortened. Redaction alone does NOT set this. */
  truncated: boolean;
}

/** Replaces every credential shape found inside one string. */
export function redactSecretsInString(input: string): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    // The query-parameter pattern keeps its `name=` prefix so the reader can
    // still see WHICH parameter was removed.
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" ? `${prefix}${REDACTED}` : REDACTED
    );
  }
  return out;
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/**
 * Deep-copies `input` into a JSON-safe value with secrets removed and sizes
 * capped.
 *
 * Never throws. A value it cannot represent (a function, a symbol, a getter that
 * blows up) becomes a short descriptive string rather than taking the caller
 * down — a trace write must never be able to fail a generation.
 */
export function sanitizeForTrace<T = unknown>(input: unknown): SanitizeResult<T> {
  let truncated = false;
  const seen = new WeakSet<object>();

  const cap = (text: string): string => {
    if (text.length <= MAX_STRING_CHARS) return text;
    truncated = true;
    return `${text.slice(0, MAX_STRING_CHARS)}…[truncated ${text.length - MAX_STRING_CHARS} chars]`;
  };

  const walk = (value: unknown, depth: number, keyHint: string | null): unknown => {
    if (value === null || value === undefined) return null;

    switch (typeof value) {
      case "string":
        if (keyHint !== null && isSecretKey(keyHint)) return REDACTED;
        return cap(redactSecretsInString(value));
      case "number":
        return Number.isFinite(value) ? value : String(value);
      case "boolean":
        return value;
      case "bigint":
        return value.toString();
      case "function":
        return "[function]";
      case "symbol":
        return value.toString();
    }

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (value instanceof Error) {
      return { name: value.name, message: cap(redactSecretsInString(value.message)) };
    }
    if (value instanceof Map) {
      return walk(Object.fromEntries(value.entries()), depth, keyHint);
    }
    if (value instanceof Set) {
      return walk([...value.values()], depth, keyHint);
    }

    // Below here `value` is an object or array.
    if (depth >= MAX_DEPTH) {
      truncated = true;
      return "[max depth reached]";
    }
    if (seen.has(value as object)) return "[circular]";
    seen.add(value as object);

    try {
      if (Array.isArray(value)) {
        // A whole array under a secret key is a list of secrets.
        if (keyHint !== null && isSecretKey(keyHint)) return REDACTED;
        const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => walk(item, depth + 1, null));
        if (value.length > MAX_ARRAY_ITEMS) {
          truncated = true;
          items.push(`[${value.length - MAX_ARRAY_ITEMS} more items omitted]`);
        }
        return items;
      }

      const entries = Object.entries(value as Record<string, unknown>);
      const out: Record<string, unknown> = {};
      for (const [key, child] of entries.slice(0, MAX_OBJECT_KEYS)) {
        out[key] = walk(child, depth + 1, key);
      }
      if (entries.length > MAX_OBJECT_KEYS) {
        truncated = true;
        out["__omitted"] = `${entries.length - MAX_OBJECT_KEYS} more keys omitted`;
      }
      return out;
    } catch {
      // A getter that threw, or an exotic host object. Say so rather than fail.
      return "[unserializable]";
    } finally {
      seen.delete(value as object);
    }
  };

  try {
    return { value: walk(input, 0, null) as T, truncated };
  } catch {
    return { value: "[unserializable]" as T, truncated: true };
  }
}

/**
 * A readable prefix of a long text, for a step that REFERENCES the full artifact
 * rather than copying it (see GenerationStep.linkedRunId).
 */
export function excerpt(text: string | null | undefined, chars = 600): string | null {
  if (text === null || text === undefined) return null;
  const clean = redactSecretsInString(text);
  return clean.length <= chars ? clean : `${clean.slice(0, chars)}…`;
}
