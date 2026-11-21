import { backendOrigin, backendTimeoutMs, FrontendConfigError } from "@/lib/server/env";
import { proxyToBackend } from "@/lib/server/proxy";

export const dynamic = "force-dynamic";

async function handle(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  let origin: string;
  try {
    origin = backendOrigin();
  } catch (error) {
    const message = error instanceof FrontendConfigError ? error.message : "Frontend misconfigured.";
    return Response.json(
      { success: false, data: null, error: { code: "FRONTEND_MISCONFIGURED", message, details: null } },
      { status: 500 },
    );
  }
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  return proxyToBackend(request, path, { origin, timeoutMs: backendTimeoutMs(), clientIp });
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
