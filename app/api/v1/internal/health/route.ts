import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { verifyCronRequest } from "@/lib/security/cron-auth";

export const dynamic = "force-dynamic";

/**
 * Operational health check: database connectivity + status of the last cron
 * run. Protected by the same API key as the other internal routes.
 */
export async function GET(request: Request) {
  const auth = verifyCronRequest(request);
  if (auth === "not_configured") {
    return NextResponse.json(
      {
        error: {
          code: "CONFIGURATION_ERROR",
          message: "Set the CRON_SECRET environment variable.",
        },
      },
      { status: 500 }
    );
  }
  if (auth === "unauthorized") {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid or missing cron credentials." } },
      { status: 401 }
    );
  }

  let databaseOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseOk = true;
  } catch (err) {
    console.error("[health] Database check failed:", err);
  }

  const lastRun = await prisma.cronRun
    .findFirst({
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        startedAt: true,
        completedAt: true,
        status: true,
        error: true,
      },
    })
    .catch(() => null);

  const healthy = databaseOk && lastRun?.status !== "failed";

  return NextResponse.json(
    {
      data: {
        status: healthy ? "ok" : "degraded",
        database: databaseOk,
        lastCronRun: lastRun
          ? {
              id: lastRun.id,
              status: lastRun.status,
              startedAt: lastRun.startedAt.toISOString(),
              completedAt: lastRun.completedAt?.toISOString() ?? null,
              error: lastRun.error,
            }
          : null,
      },
    },
    { status: healthy ? 200 : 503 }
  );
}
