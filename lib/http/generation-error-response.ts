/**
 * The HTTP answer for a failed post generation.
 *
 * Shared by the single-post route and the bulk route so the two can never drift:
 * a caller that asked for five posts and got none must be told the same thing,
 * with the same code and the same status, as a caller that asked for one.
 *
 * Codes are returned verbatim — the client translates them through
 * `lib/i18n/api-error.ts`; the English `message` is for logs and API consumers.
 */

import { NextResponse } from "next/server";
import type { GenerateDraftPostFailure } from "@/lib/services/ai/generate-draft-post.service";

export function generationErrorResponse(result: GenerateDraftPostFailure): NextResponse {
  switch (result.code) {
    case "NOT_FOUND":
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Not found" } },
        { status: 404 }
      );

    case "FORBIDDEN":
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "Forbidden" } },
        { status: 403 }
      );

    case "INVALID_CHANNEL":
      return NextResponse.json(
        {
          error: {
            code: "INVALID_CHANNEL",
            message: "Invalid channel. Must be one of: facebook, linkedin, instagram, tiktok",
          },
        },
        { status: 422 }
      );

    case "NO_ACTIVE_PROVIDER":
      return NextResponse.json(
        {
          error: {
            code: "NO_ACTIVE_PROVIDER",
            message: "No default AI model is configured. Contact an administrator.",
          },
        },
        { status: 503 }
      );

    case "LLM_CONFIG_NOT_FOUND":
      return NextResponse.json(
        {
          error: {
            code: "LLM_CONFIG_NOT_FOUND",
            message: "The selected LLM is no longer available. Pick another or use the default.",
          },
        },
        { status: 404 }
      );

    case "PROVIDER_CONFIG_MISSING":
      return NextResponse.json(
        {
          error: {
            code: "PROVIDER_CONFIG_MISSING",
            message: result.message ?? "The selected LLM is missing required configuration.",
          },
        },
        { status: 503 }
      );

    case "LLM_RATE_LIMITED": {
      const retryAfterSec =
        result.retryAfterMs !== undefined
          ? Math.max(1, Math.ceil(result.retryAfterMs / 1000))
          : undefined;
      return NextResponse.json(
        {
          error: {
            code: "LLM_RATE_LIMITED",
            message: "The AI provider is temporarily rate limited. Please try again shortly.",
            retryAfterMs: result.retryAfterMs,
          },
        },
        {
          status: 429,
          // Standard header so clients/proxies can honour the provider's wait.
          headers: retryAfterSec !== undefined ? { "retry-after": String(retryAfterSec) } : {},
        }
      );
    }

    case "LLM_PROVIDER_ERROR":
      return NextResponse.json(
        { error: { code: "LLM_PROVIDER_ERROR", message: result.message ?? "LLM provider error" } },
        { status: 502 }
      );

    case "LLM_RESPONSE_PARSE_ERROR":
      return NextResponse.json(
        {
          error: {
            code: "LLM_RESPONSE_PARSE_ERROR",
            message: result.message ?? "Failed to parse LLM response",
          },
        },
        { status: 502 }
      );

    case "POST_TOO_LONG_WITH_URL":
      return NextResponse.json(
        {
          error: {
            code: "POST_TOO_LONG_WITH_URL",
            message: result.message ?? "Post text plus source URL exceeds the channel text limit",
          },
        },
        { status: 422 }
      );

    case "NO_FEED_ITEMS_AVAILABLE":
      return NextResponse.json(
        {
          error: {
            code: "NO_FEED_ITEMS_AVAILABLE",
            message:
              "No unused source articles are available to generate from right now. Ingest a content source to fetch new articles, or add an RSS source.",
          },
        },
        { status: 409 }
      );

    case "SELECTED_SOURCE_UNAVAILABLE":
      // 409, matching its sibling NO_FEED_ITEMS_AVAILABLE: the request is
      // well-formed, the world changed under it.
      return NextResponse.json(
        {
          error: {
            code: "SELECTED_SOURCE_UNAVAILABLE",
            message: result.message ?? "The selected content source can no longer back a post.",
          },
        },
        { status: 409 }
      );

    case "CANNOT_GENERATE_UNIQUE_POST":
      return NextResponse.json(
        {
          error: {
            code: "CANNOT_GENERATE_UNIQUE_POST",
            message:
              result.message ??
              "Could not generate a sufficiently unique post. Try again later or add fresh source material.",
            // Diagnostics so the UI can explain WHY and after how many tries.
            reason: result.reason,
            attempts: result.attempts,
          },
        },
        { status: 409 }
      );

    case "POST_FAILED_COMPLIANCE":
      // 409, like its sibling above: the request was fine, the generator could
      // not produce a post that met its own requirements. The reasons ride
      // along so the UI can say WHAT was missing, not just that something was.
      return NextResponse.json(
        {
          error: {
            code: "POST_FAILED_COMPLIANCE",
            message:
              result.message ??
              "The generated post did not follow its required content pattern. Try again.",
            reasons: result.complianceReasons,
            attempts: result.attempts,
          },
        },
        { status: 409 }
      );
  }
}
