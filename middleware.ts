function readCookie(request: Request, name: string) {
  const cookies = request.headers.get("cookie") || "";
  const prefix = `${name}=`;
  for (const part of cookies.split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
  }
  return "";
}

async function sessionTokenFor(accessCode: string) {
  const bytes = new TextEncoder().encode(accessCode);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default async function middleware(request: Request) {
  const url = new URL(request.url);
  const publicPaths = new Set(["/login.html", "/api/login", "/api/logout", "/api/health"]);
  if (publicPaths.has(url.pathname)) return;

  const accessCode = process.env.APP_ACCESS_CODE || "";
  const expectedToken = accessCode ? await sessionTokenFor(accessCode) : "";
  const sessionToken = readCookie(request, "shine_auth");
  if (expectedToken && sessionToken === expectedToken) return;

  if (url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "請先登入。" }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    });
  }

  const loginUrl = new URL("/login.html", request.url);
  loginUrl.searchParams.set("next", `${url.pathname}${url.search}`);
  return Response.redirect(loginUrl, 303);
}

export const config = {
  matcher: "/:path*"
};
