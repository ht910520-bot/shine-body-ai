import { timingSafeEqual } from "node:crypto";
import { analyzeFoodImage } from "./analyzeFoodImage.js";
import { analyzeFoodText } from "./analyzeFoodText.js";
import { MISSING_AI_CONFIG_ERROR, hasWorkersAi, type AiEnv } from "./cloudflareAi.js";
import { sessionTokenFor } from "./sessionAuth.js";
import { handleUserData, type DataApiResponse } from "./userDataApi.js";
import { createDataStorage, type StorageEnv } from "./storage.js";

export const ANALYSIS_LIMIT = 20;
export const ANALYSIS_WINDOW_MS = 60 * 60 * 1000;
export const LOGIN_LIMIT = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_IMAGE_CHARS = 15_000_000;
const MAX_BODY_BYTES = 20_000_000;

export interface RuntimeEnv extends AiEnv, StorageEnv {
  APP_ACCESS_CODE?: string;
}

type Bucket = { count: number; resetAt: number };
const analysisBuckets = new Map<string, Bucket>();
const loginBuckets = new Map<string, Bucket>();

function tooMany(buckets: Map<string, Bucket>, key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const usage = buckets.get(key);
  if (!usage || usage.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  if (usage.count >= limit) return true;
  usage.count += 1;
  return false;
}

export function resetRateLimits() {
  analysisBuckets.clear();
  loginBuckets.clear();
}

export function clientKey(request: Request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

export function json(body: unknown, status = 200, extra?: HeadersInit) {
  const headers = new Headers(extra);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function equalText(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { tooLarge: true as const, body: null };
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { tooLarge: true as const, body: null };
  if (!text) return { tooLarge: false as const, body: {} };
  try {
    return { tooLarge: false as const, body: JSON.parse(text) };
  } catch {
    return { tooLarge: false as const, body: null };
  }
}

function sessionCookie(token: string) {
  return `shine_auth=${token}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function handleHealth() {
  return json({ ok: true, service: "shine-body-ai", platform: "cloudflare" });
}

export async function handleLogin(request: Request, env: RuntimeEnv) {
  if (request.method !== "POST") {
    return json({ error: "只接受 POST 請求。" }, 405, { Allow: "POST" });
  }
  const accessCode = env.APP_ACCESS_CODE || "";
  if (!accessCode) return json({ error: "登入服務尚未完成設定。" }, 500);

  const client = clientKey(request);
  if (tooMany(loginBuckets, client, LOGIN_LIMIT, LOGIN_WINDOW_MS)) {
    return json({ error: "嘗試次數過多，請 15 分鐘後再試。" }, 429);
  }

  const parsed = await readJson(request);
  if (parsed.tooLarge) return json({ error: "照片檔案太大，請重新選擇照片。" }, 413);
  if (parsed.body == null) return json({ error: "請輸入密碼。" }, 400);
  const password = String((parsed.body as { password?: unknown }).password || "");
  if (!equalText(password, accessCode)) return json({ error: "密碼不正確。" }, 401);

  loginBuckets.delete(client);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(sessionTokenFor(accessCode)) });
}

export function handleLogout() {
  return json({ ok: true }, 200, {
    "Set-Cookie": "shine_auth=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax"
  });
}

export async function handleAnalyzeFood(request: Request, env: RuntimeEnv) {
  if (request.method !== "POST") {
    return json({ error: "只接受 POST 請求。" }, 405, { Allow: "POST" });
  }
  if (!hasWorkersAi(env)) return json({ error: MISSING_AI_CONFIG_ERROR }, 500);

  const parsed = await readJson(request);
  if (parsed.tooLarge) return json({ error: "照片檔案太大，請重新選擇照片。" }, 413);
  if (parsed.body == null || typeof parsed.body !== "object") return json({ error: "請提供食物照片。" }, 400);
  const { image, mimeType } = parsed.body as { image?: unknown; mimeType?: unknown };
  if (!image || typeof image !== "string") return json({ error: "請提供食物照片。" }, 400);
  if (image.length > MAX_IMAGE_CHARS) return json({ error: "照片檔案太大，請重新選擇照片。" }, 413);
  if (tooMany(analysisBuckets, clientKey(request), ANALYSIS_LIMIT, ANALYSIS_WINDOW_MS)) {
    return json({ error: "分析次數過多，請一小時後再試。" }, 429);
  }

  try {
    const result = await analyzeFoodImage(image, typeof mimeType === "string" ? mimeType : undefined, env);
    return json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "analyze_food_failed", message }));
    return json({ error: `AI 照片分析失敗: ${message}` }, 500);
  }
}

export async function handleAnalyzeFoodText(request: Request, env: RuntimeEnv) {
  if (request.method !== "POST") {
    return json({ error: "只接受 POST 請求。" }, 405, { Allow: "POST" });
  }
  if (!hasWorkersAi(env)) return json({ error: MISSING_AI_CONFIG_ERROR }, 500);

  const parsed = await readJson(request);
  if (parsed.body == null || typeof parsed.body !== "object") return json({ error: "請輸入餐點名稱或描述。" }, 400);
  const { text, followUpAnswer, previous } = parsed.body as {
    text?: unknown;
    followUpAnswer?: unknown;
    previous?: unknown;
  };
  if (!text || typeof text !== "string" || !text.trim()) return json({ error: "請輸入餐點名稱或描述。" }, 400);
  if (text.length > 500) return json({ error: "餐點描述請控制在 500 字以內。" }, 400);
  if (tooMany(analysisBuckets, clientKey(request), ANALYSIS_LIMIT, ANALYSIS_WINDOW_MS)) {
    return json({ error: "分析次數過多，請一小時後再試。" }, 429);
  }

  try {
    const result = await analyzeFoodText(
      text,
      typeof followUpAnswer === "string" ? followUpAnswer : undefined,
      previous,
      env
    );
    return json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "analyze_food_text_failed", message }));
    return json({ error: `AI 飲食查詢失敗: ${message}` }, 500);
  }
}

class CollectedResponse implements DataApiResponse {
  statusCode = 200;
  body: unknown = null;
  headers = new Map<string, string>();
  headersSent = false;

  setHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(body: unknown) {
    this.body = body;
    this.headersSent = true;
    return body;
  }
}

export async function handleData(request: Request, env: RuntimeEnv) {
  const collected = new CollectedResponse();
  let body: unknown;
  if (request.method.toUpperCase() === "PUT") {
    const parsed = await readJson(request);
    if (parsed.tooLarge) return json({ error: "資料太大，無法同步。" }, 413);
    body = parsed.body;
  }
  await handleUserData({
    method: request.method,
    headers: { cookie: request.headers.get("cookie") || "" },
    body
  }, collected, undefined, env);
  const headers = new Headers();
  for (const [name, value] of collected.headers) headers.set(name, value);
  return json(collected.body, collected.statusCode, headers);
}

export async function handleApi(request: Request, env: RuntimeEnv) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") return handleHealth();
  if (url.pathname === "/api/login") return handleLogin(request, env);
  if (url.pathname === "/api/logout") return handleLogout();
  if (url.pathname === "/api/data") return handleData(request, env);
  if (url.pathname === "/api/analyze-food") return handleAnalyzeFood(request, env);
  if (url.pathname === "/api/analyze-food-text") return handleAnalyzeFoodText(request, env);
  return json({ error: "找不到這個 API。" }, 404);
}
