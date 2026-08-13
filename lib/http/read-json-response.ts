/**
 * Reading an API response that is SUPPOSED to be JSON.
 *
 * Every route in `app/api/v1` answers with JSON, success or failure — but the
 * client does not only ever hear from the route. Between the browser and the
 * handler sit a platform gateway, a proxy and a load balancer, and when one of
 * those answers instead of the function it answers in its own words:
 *
 *     An error occurred with this application.
 *
 *     FUNCTION_INVOCATION_TIMEOUT
 *
 * `await res.json()` on that body throws `SyntaxError: Unexpected token 'A',
 * "An error o"... is not valid JSON`, and because every caller wraps its fetch
 * in a try/catch that shows `err.message`, the parser's complaint about the
 * first character is what the USER is shown. The real failure — a request that
 * ran past the function cap — never reaches them, and the message that does
 * reach them looks like a front-end bug.
 *
 * So responses are read as text and parsed here. A body that is not JSON becomes
 * a structured error with a code, exactly like one the API itself would have
 * returned, and the existing `useApiErrorMessage` translation path carries it to
 * the user unchanged. No caller needs its own guard, and none can forget one.
 *
 * The parsing half is pure and separately exported so it can be tested against
 * real gateway bodies without a `Response`.
 */

/**
 * The response was not JSON at all — something upstream of the route answered.
 * Synthesized here; the API never sends it.
 */
export const NON_JSON_RESPONSE_CODE = "SERVER_UNREACHABLE";

/**
 * The response was not JSON AND names a timeout — the request ran past the
 * platform's function limit. Distinguished from the code above because the
 * remedy is completely different: not "try again", but "that was too much work
 * for one request". Synthesized here; the API never sends it.
 */
export const GATEWAY_TIMEOUT_CODE = "REQUEST_TIMED_OUT";

/**
 * How gateways say "the function ran too long". Matched case-insensitively
 * against the body, alongside the 504 status, because a platform is free to
 * report this with a 500.
 */
const TIMEOUT_MARKERS = [
  "FUNCTION_INVOCATION_TIMEOUT",
  "GATEWAY_TIMEOUT",
  "Task timed out",
  "504 Gateway Time-out",
];

/** How much of an unparseable body is kept for diagnosis. */
const SNIPPET_LIMIT = 200;

export interface ApiErrorBody {
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export interface JsonResponseBody {
  error?: ApiErrorBody;
  [key: string]: unknown;
}

/** Collapses whitespace and truncates, so a gateway's HTML is loggable on one line. */
export function bodySnippet(body: string, limit = SNIPPET_LIMIT): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function looksLikeTimeout(status: number, body: string): boolean {
  if (status === 504) return true;
  const haystack = body.toLowerCase();
  return TIMEOUT_MARKERS.some((marker) => haystack.includes(marker.toLowerCase()));
}

/**
 * Turns a raw response body into an object a caller can read `error.code` from.
 *
 * Always returns an object. A body that parses to JSON is returned as-is — the
 * API's own answer, untouched, including a `{ error: … }` it chose to send. A
 * body that does not parse (or parses to something that is not an object, like
 * the bare `null` some proxies send) becomes a synthesized structured error
 * carrying the raw text as its `message` so a developer reading the network tab
 * or a log still sees what actually came back.
 *
 * The synthesized `message` is deliberately NOT what the user is shown: neither
 * synthesized code is in `DETAIL_CODES`, so `useApiErrorMessage` translates the
 * code and drops the gateway's English.
 */
export function parseJsonBody(status: number, body: string): JsonResponseBody {
  if (body.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(body);
      // Arrays and primitives are not this API's shape; treating them as a body
      // would hand the caller `json.error === undefined` on a broken response
      // and it would report success.
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as JsonResponseBody;
      }
    } catch {
      // Falls through to the synthesized error below.
    }
  }

  const timedOut = looksLikeTimeout(status, body);
  return {
    error: {
      code: timedOut ? GATEWAY_TIMEOUT_CODE : NON_JSON_RESPONSE_CODE,
      message: timedOut
        ? `The request exceeded the server's time limit (HTTP ${status}).`
        : `The server returned a non-JSON response (HTTP ${status}).`,
      // The raw answer, for the network tab and for logs. Empty for an empty body.
      body: bodySnippet(body),
      status,
    },
  };
}

/**
 * Reads a `Response` as JSON without ever throwing on its body.
 *
 * Use in place of `await res.json()` for every API call. Check `res.ok` and
 * `res.status` on the response as before — this only replaces the parse.
 */
export async function readJsonResponse(res: Response): Promise<JsonResponseBody> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    // The connection dropped mid-body. There is nothing to parse, and the
    // synthesized error below is the honest report of exactly that.
  }
  return parseJsonBody(res.status, text);
}
