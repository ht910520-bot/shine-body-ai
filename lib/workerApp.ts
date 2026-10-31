import { authorizeRequest } from "./accessGate.js";
import { handleApi, type RuntimeEnv } from "./apiRoutes.js";

export interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerRuntime extends RuntimeEnv {
  ASSETS?: AssetBinding;
}

export async function handleWorkerRequest(request: Request, env: WorkerRuntime) {
  const denied = authorizeRequest(request, env.APP_ACCESS_CODE || "");
  if (denied) return denied;

  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return handleApi(request, env);
  if (!env.ASSETS) {
    return new Response("Static assets are not configured.", { status: 500 });
  }
  return env.ASSETS.fetch(request);
}
