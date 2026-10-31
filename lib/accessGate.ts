import { isValidSession } from "./sessionAuth.js";

export const PUBLIC_PATHS = new Set(["/login.html", "/api/login", "/api/logout", "/api/health"]);

export function authorizeRequest(request: Request, accessCode: string) {
  const url = new URL(request.url);
  if (PUBLIC_PATHS.has(url.pathname)) return null;
  if (isValidSession(request.headers.get("cookie") || "", accessCode)) return null;

  if (url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "請先登入。" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }

  const loginUrl = new URL("/login.html", request.url);
  loginUrl.searchParams.set("next", `${url.pathname}${url.search}`);
  return Response.redirect(loginUrl.toString(), 303);
}
