"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";

/**
 * Every error code the API can return. Kept in sync with the `apiErrors`
 * namespace in i18n/messages/{en,bg}.json — each code has a translation there.
 */
export const API_ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INTERNAL_SERVER_ERROR",
  "VALIDATION_ERROR",
  "INVALID_JSON",
  "INVALID_TRANSITION",
  "INVALID_STATUS",
  // Publishing (v2-9) — a manually scheduled post cannot be sent before its time.
  "NOT_DUE",
  "TOKEN_EXPIRED",
  "POST_LOCKED",
  "NO_CONNECTION",
  "INVALID_FILE",
  "INVALID_CHANNEL",
  "BUFFER_API_ERROR",
  "BAD_REQUEST",
  "VERSION_NOT_FOUND",
  "USER_NOT_FOUND",
  "UPLOAD_FAILED",
  "UNSUPPORTED_TYPE",
  "NO_IMAGE_PROMPT",
  "NO_ACTIVE_PROVIDER",
  "LLM_CONFIG_NOT_FOUND",
  "PROVIDER_CONFIG_MISSING",
  "LLM_RESPONSE_PARSE_ERROR",
  "LLM_RATE_LIMITED",
  "LLM_PROVIDER_ERROR",
  "INVALID_REQUEST",
  "INVALID_PROFILE",
  // Publishing — the chosen Buffer profile is on a different social network
  // than the post (a Facebook post aimed at an Instagram profile).
  "CHANNEL_MISMATCH",
  "INVALID_CREDENTIALS",
  "IMAGE_PROVIDER_ERROR",
  "FILE_TOO_LARGE",
  "EMAIL_ALREADY_EXISTS",
  "CONFIGURATION_ERROR",
  "CANNOT_REMOVE_SELF",
  "CANNOT_REMOVE_LAST_OWNER",
  "CANNOT_DELETE_ACTIVE",
  "CANNOT_CHANGE_OWN_ROLE",
  "ALREADY_MEMBER",
  "INGEST_FAILED",
  "EMAIL_NOT_VERIFIED",
  "POST_TOO_LONG_WITH_URL",
  "CANNOT_GENERATE_UNIQUE_POST",
  "NO_FEED_ITEMS_AVAILABLE",
  // Manual generation — the RSS source picked in the form ran dry (or went away).
  "SELECTED_SOURCE_UNAVAILABLE",
  // Channel policy (v2-3) — a verified platform constraint blocked the publish.
  "POLICY_VIOLATION",
  // Content mix (v2-8) — a rejected generation distribution.
  "MIX_SOURCE_UNASSIGNED",
  "MIX_INVALID_VALUE",
  "MIX_EMPTY",
  "MIX_EXCEEDS_MAX",
  "UNKNOWN_SOURCE",
  // Source article image — the post has no article image to switch to, no
  // earlier image to switch back to, or the publisher's image could not be used.
  "NO_SOURCE_IMAGE",
  "NO_PREVIOUS_IMAGE",
  "SOURCE_IMAGE_UNAVAILABLE",
  // Manual bulk generation — the request itself is out of bounds.
  "INVALID_POST_COUNT",
  "INVALID_DATE_RANGE",
  "INVALID_DISTRIBUTION",
  // …and its content mix names a source this company does not have, or does not
  // add up to the number of posts asked for.
  "INVALID_SOURCE_MIX",
  // Rescheduling — the requested publish time is not one a post can be given.
  "INVALID_SCHEDULE",
  // Approval — the post's own hand-chosen time went by before anybody approved
  // it, so a new one has to be picked first.
  "SCHEDULE_MISSED",
  // Not sent by the API — synthesized by lib/http/read-json-response.ts when
  // something UPSTREAM of the route answered (a gateway error page, a dropped
  // connection), so a non-JSON body still reaches the user as a real message
  // instead of as a JSON parser's complaint about its first character.
  "SERVER_UNREACHABLE",
  "REQUEST_TIMED_OUT",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

/**
 * Codes whose server message carries provider-specific detail (e.g. the exact
 * validation error Buffer returned) that a generic translation would hide.
 * For these, the detail is appended after the translated label.
 */
const DETAIL_CODES: ReadonlySet<string> = new Set([
  "BUFFER_API_ERROR",
  "UPLOAD_FAILED",
  // The violated constraint's description names WHICH requirement failed —
  // a generic label would hide it. Before v2-3 this same guidance reached the
  // user as BUFFER_API_ERROR detail, so keeping it preserves the behaviour.
  "POLICY_VIOLATION",
  // Names WHY the publisher's image failed — a dead link, a redirect to an HTML
  // error page, a file over the size cap. Without the detail the user cannot
  // tell a broken URL from a format we refuse.
  "SOURCE_IMAGE_UNAVAILABLE",
]);

export interface ApiErrorShape {
  code?: string;
  message?: string;
}

/** Extracts `{ code, message }` from an unknown API response body, if present. */
export function extractApiError(body: unknown): ApiErrorShape | null {
  if (body === null || typeof body !== "object" || !("error" in body)) return null;
  const error = (body as { error: unknown }).error;
  if (error === null || typeof error !== "object") return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return {
    code: typeof code === "string" ? code : undefined,
    message: typeof message === "string" ? message : undefined,
  };
}

/**
 * Returns a function that resolves an API error to a translated, user-facing
 * message. Known codes map to the `apiErrors` namespace; unknown or missing
 * codes fall back to the provided fallback, or the generic translated error.
 */
export function useApiErrorMessage() {
  const t = useTranslations("apiErrors");

  return useCallback(
    (error?: ApiErrorShape | null, fallback?: string): string => {
      const code = error?.code;
      if (code && KNOWN_CODES.has(code)) {
        if (DETAIL_CODES.has(code) && error?.message) return `${t(code)}: ${error.message}`;
        return t(code);
      }
      return fallback ?? t("UNKNOWN");
    },
    [t]
  );
}
