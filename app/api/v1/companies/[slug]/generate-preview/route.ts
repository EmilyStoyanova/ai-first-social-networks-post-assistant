import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { buildGenerationContext } from "@/lib/services/ai/build-generation-context.service";
import { resolveGenerationAspect } from "@/lib/services/ai/resolve-generation-aspect.service";
import { buildPrompts } from "@/lib/ai/prompt-builder";
import { previewPrimaryItem } from "@/lib/ai/primary-feed-item";
import { resolveLlmSelection } from "@/lib/services/ai/resolve-llm-selection.service";
import { buildSupportedProvider } from "@/lib/ai/llm/supported-providers";
import { prisma } from "@/lib/db/client";
import { type SocialChannel } from "@prisma/client";
import { GenerationTracer } from "@/lib/generation-trace/tracer";
import { observeProvider } from "@/lib/generation-trace/observed-provider";

const bodySchema = z.object({
  channel: z
    .string()
    .transform((v) => v.toLowerCase())
    .pipe(z.enum(["facebook", "linkedin", "instagram", "tiktok"])),
  // Omitted = "Default": inherit the channel's configured posting language,
  // mirroring the real generate endpoint.
  contentLanguage: z.enum(["en", "bg"]).optional(),
  // Mirrors the real generate endpoint so a preview reflects the same choice.
  llmConfigId: z.string().min(1).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { slug } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_JSON", message: "Invalid JSON" } },
      { status: 400 }
    );
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          issues: parsed.error.issues,
        },
      },
      { status: 422 }
    );
  }

  const result = await buildGenerationContext(
    slug,
    parsed.data.channel,
    session.user.id,
    session.user.isGlobalAdmin
  );

  if (!result.success) {
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
    }
  }

  const { context, companyId } = result;

  // ── Provider selection (identical to real generation) ─────────────────────
  // Resolved from LlmConfig rows via the shared resolver — never from env — so
  // the provider/model shown here is the one a real generation would use.
  let preferredLlmConfigId: string | null = null;
  if (!parsed.data.llmConfigId) {
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { preferredLlmConfigId: true },
    });
    preferredLlmConfigId = user?.preferredLlmConfigId ?? null;
  }

  const selectionResult = await resolveLlmSelection({
    llmConfigId: parsed.data.llmConfigId ?? null,
    preferredLlmConfigId,
  });

  if (!selectionResult.success) {
    switch (selectionResult.code) {
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
    }
  }

  const { selection } = selectionResult;

  // ── Aspect mining (same logic as real generation) ─────────────────────────
  // Query recent posts so we can load the existing aspect pool for this context.
  const recentRows = await prisma.post.findMany({
    where: { companyId, channel: parsed.data.channel as SocialChannel },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { promptSnapshot: true },
  });
  const snapshots = recentRows.map((r) => r.promptSnapshot as Record<string, unknown> | null);

  // A preview reserves nothing, so there is no claim to read the primary from.
  // Forecast the article a real generation would claim, and build the whole
  // preview — aspect included — around that one item, so the preview cannot show
  // an aspect for an article the real post would not be about.
  const primaryItem = previewPrimaryItem(context.feedItems);

  /**
   * A preview is traced because it really RUNS something.
   *
   * It writes no post, claims no article and calls no generation model — but
   * aspect mining is a genuine LLM call against the same provider a real
   * generation would use, and the prompts it returns are the prompts that would
   * be sent. So it gets a run of its own, marked `preview` and with a null post
   * id, rather than being silently absent from a company's history of what its
   * AI was asked to do. It is deliberately NOT a post's trace: no post exists.
   */
  const tracer = GenerationTracer.start({
    kind: "post_generation",
    trigger: "preview",
    companyId,
    channel: parsed.data.channel,
    language: parsed.data.contentLanguage ?? context.channel.postingLanguage,
    userId: session.user.id,
    options: { channel: parsed.data.channel, contentLanguage: parsed.data.contentLanguage ?? null },
  });
  tracer.setLlm(selection.providerLabel, selection.model);
  tracer.step({
    type: "request",
    label: "Prompt preview (no post is written)",
    input: {
      companyId,
      channel: parsed.data.channel,
      contentLanguage: parsed.data.contentLanguage ?? null,
      requestedBy: session.user.id,
    },
  });

  try {
    if (primaryItem) {
      tracer.step({
        type: "source",
        label: `Forecast article — ${primaryItem.sourceName ?? "unnamed"}`,
        output: {
          feedItemId: primaryItem.id,
          title: primaryItem.title,
          url: primaryItem.publicUrl ?? primaryItem.url,
          content: primaryItem.content,
        },
        metadata: {
          note: "Forecast only — a preview reserves nothing, so a real generation may claim a different article.",
          usedTranslation: primaryItem.usedTranslation === true,
        },
      });
    }

    // Get the provider for potential extraction (graceful no-op if unavailable).
    let selectedAspect: import("@/lib/ai/content-aspect").ContentAspect | undefined;
    try {
      const provider =
        process.env.AI_MOCK_MODE === "true"
          ? { generate: async () => ({ text: "[]" }) }
          : buildSupportedProvider(selection.provider).instance;

      const aspectResult = await resolveGenerationAspect({
        primary: primaryItem,
        snapshots,
        // Observed, so the one LLM call a preview really makes is on the record
        // with its exact prompt and reply — the same wrapper generation uses.
        provider: observeProvider(provider, (call) => {
          tracer.step({
            type: "llm_call",
            label: "Aspect mining",
            status: call.error ? "failed" : "success",
            startedAt: call.startedAt,
            completedAt: call.completedAt,
            durationMs: call.durationMs,
            input: { systemPrompt: call.systemPrompt, userPrompt: call.userPrompt },
            metadata: { request: call.request },
            error: call.error ? `${call.error.name}: ${call.error.message}` : undefined,
          });
          if (call.responseText !== null) {
            tracer.step({
              type: "raw_response",
              label: "Aspect mining",
              output: { text: call.responseText },
            });
          }
        }),
      });
      selectedAspect = aspectResult.aspect;
    } catch (err) {
      // No provider or extraction failed — show prompt without aspect (same as generation would do)
      selectedAspect = undefined;
      tracer.step({
        type: "llm_call",
        label: "Aspect mining unavailable",
        status: "skipped",
        error: err,
      });
    }

    const { systemPrompt, userPrompt } = buildPrompts(
      context,
      primaryItem,
      parsed.data.contentLanguage,
      [],
      { aspect: selectedAspect }
    );

    tracer.step({
      type: "context",
      label: "Generation context",
      output: {
        company: context.company,
        brandGuidelines: context.brand,
        channelSettings: context.channel,
        selectedAspect: selectedAspect ?? null,
      },
      metadata: { candidateCount: context.feedItems.length, llmConfigId: selection.llmConfigId },
    });
    tracer.step({
      type: "prompt",
      label: "Prompts as they would be sent",
      input: { systemPrompt, userPrompt },
      metadata: {
        systemPromptChars: systemPrompt.length,
        userPromptChars: userPrompt.length,
        // A preview stops here on purpose — nothing is generated from these.
        sent: false,
      },
    });

    return NextResponse.json({
      provider: selection.providerLabel,
      model: selection.model,
      llmConfigId: selection.llmConfigId,
      systemPrompt,
      userPrompt,
      selectedAspect: selectedAspect ?? null,
    });
  } finally {
    await tracer.flush();
  }
}
