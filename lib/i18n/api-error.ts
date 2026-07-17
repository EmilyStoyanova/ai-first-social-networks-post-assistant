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
  // Channel policy (v2-3) — a verified platform constraint blocked the publish.
  "POLICY_VIOLATION",
  // Content mix (v2-8) — a rejected generation distribution.
  "MIX_TOTAL_MISMATCH",
  "MIX_SOURCE_UNASSIGNED",
  "MIX_CHANNEL_TARGETS_DIFFER",
  "MIX_INVALID_VALUE",
  "MIX_EXCEEDS_MAX",
  "MIX_UNSUPPORTED_FALLBACK",
  "UNKNOWN_SOURCE",
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
