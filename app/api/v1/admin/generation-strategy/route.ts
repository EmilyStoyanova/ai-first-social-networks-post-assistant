import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  readGenerationStrategySettings,
  updateGenerationStrategySettings,
} from "@/lib/services/admin/generation-strategy-settings.service";

/**
 * The site-wide generation strategy default and the single-vs-multi experiment.
 *
 * Global-admin only, like the LLM provider routes it sits beside. GET returns
 * the current settings (or the defaults, when none have been saved); PUT applies
 * a partial change and returns the result.
 */

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    defaultStrategy: z.enum(["single", "multi"]).optional(),
    experimentEnabled: z.boolean().optional(),
    experimentAllocationPercent: z.number().int().min(0).max(100).optional(),
    /** Start a NEW experiment — mints a fresh key, discarding comparability. */
    resetKey: z.boolean().optional(),
  })
  .strict();

export async function GET() {
  const session = await auth();
  if (!session) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
      { status: 401 }
    );
  }
  const result = await readGenerationStrategySettings(session.user.isGlobalAdmin);
  if (!result.success) {
    return Response.json(
      { error: { code: "FORBIDDEN", message: "Global admin access required." } },
      { status: 403 }
    );
  }
  return Response.json({ settings: result.settings });
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
      { status: 401 }
    );
  }
  if (!session.user.isGlobalAdmin) {
    return Response.json(
      { error: { code: "FORBIDDEN", message: "Global admin access required." } },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { code: "INVALID_JSON", message: "Invalid JSON body." } },
      { status: 400 }
    );
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid request.";
    return Response.json({ error: { code: "VALIDATION_ERROR", message } }, { status: 400 });
  }

  try {
    const result = await updateGenerationStrategySettings(
      session.user.isGlobalAdmin,
      session.user.id,
      parsed.data
    );
    if (!result.success) {
      switch (result.code) {
        case "FORBIDDEN":
          return Response.json(
            { error: { code: "FORBIDDEN", message: "Global admin access required." } },
            { status: 403 }
          );
        case "INVALID_ALLOCATION":
          return Response.json(
            {
              error: {
                code: "VALIDATION_ERROR",
                message: "Allocation must be a whole number between 0 and 100.",
              },
            },
            { status: 400 }
          );
      }
    }
    return Response.json({ settings: result.settings });
  } catch (err) {
    console.error("[generation-strategy PUT]", err);
    return Response.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}
