export const DEFAULT_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
export const DEFAULT_TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
export const DEFAULT_VISION_MAX_TOKENS = 2_048;
export const DEFAULT_TEXT_MAX_TOKENS = 1_200;
export const DEFAULT_VISION_TIMEOUT_MS = 45_000;
export const DEFAULT_TEXT_TIMEOUT_MS = 20_000;
export const MISSING_AI_CONFIG_ERROR = "伺服器尚未設定 Cloudflare Workers AI（需要 AI binding，或 CLOUDFLARE_ACCOUNT_ID 與 CLOUDFLARE_API_TOKEN）。";

const MODEL_ID = /^@cf\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MIN_VISION_TIMEOUT_MS = 1_000;
const MAX_VISION_TIMEOUT_MS = 55_000;
const MIN_TEXT_TIMEOUT_MS = 3_000;
const MAX_TEXT_TIMEOUT_MS = 25_000;
const MIN_MAX_TOKENS = 256;
const MAX_MAX_TOKENS = 4_096;

export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface AiEnv {
  AI?: WorkersAiBinding;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_VISION_MODEL?: string;
  CLOUDFLARE_TEXT_MODEL?: string;
  CLOUDFLARE_VISION_MAX_TOKENS?: string;
  CLOUDFLARE_TEXT_MAX_TOKENS?: string;
  CLOUDFLARE_VISION_TIMEOUT_MS?: string;
  CLOUDFLARE_TEXT_TIMEOUT_MS?: string;
}

function firstNonEmpty(...values: Array<string | undefined>) {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function workersAiRunUrl(accountId: string, model: string) {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
}

export function aiEnvFromProcess(env: NodeJS.ProcessEnv = process.env): AiEnv {
  const accountId = firstNonEmpty(env.CLOUDFLARE_ACCOUNT_ID, env.CF_ACCOUNT_ID);
  const apiToken = firstNonEmpty(env.CLOUDFLARE_API_TOKEN, env.CF_API_TOKEN, env.CLOUDFLARE_AUTH_TOKEN);
  return {
    CLOUDFLARE_ACCOUNT_ID: accountId || undefined,
    CLOUDFLARE_API_TOKEN: apiToken || undefined,
    CLOUDFLARE_VISION_MODEL: env.CLOUDFLARE_VISION_MODEL,
    CLOUDFLARE_TEXT_MODEL: env.CLOUDFLARE_TEXT_MODEL,
    CLOUDFLARE_VISION_MAX_TOKENS: env.CLOUDFLARE_VISION_MAX_TOKENS,
    CLOUDFLARE_TEXT_MAX_TOKENS: env.CLOUDFLARE_TEXT_MAX_TOKENS,
    CLOUDFLARE_VISION_TIMEOUT_MS: env.CLOUDFLARE_VISION_TIMEOUT_MS,
    CLOUDFLARE_TEXT_TIMEOUT_MS: env.CLOUDFLARE_TEXT_TIMEOUT_MS
  };
}

export function hasWorkersAi(env: AiEnv) {
  if (env.AI) return true;
  return Boolean(env.CLOUDFLARE_ACCOUNT_ID?.trim() && env.CLOUDFLARE_API_TOKEN?.trim());
}

function clampNumber(value: string | undefined, fallback: number, min: number, max: number) {
  const configured = Number(value);
  if (!Number.isFinite(configured)) return fallback;
  return Math.min(Math.max(configured, min), max);
}

export function visionRuntimeConfig(env: AiEnv = aiEnvFromProcess()) {
  return {
    model: env.CLOUDFLARE_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL,
    timeoutMs: clampNumber(env.CLOUDFLARE_VISION_TIMEOUT_MS, DEFAULT_VISION_TIMEOUT_MS, MIN_VISION_TIMEOUT_MS, MAX_VISION_TIMEOUT_MS),
    maxTokens: Math.round(clampNumber(env.CLOUDFLARE_VISION_MAX_TOKENS, DEFAULT_VISION_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS))
  };
}

export function textRuntimeConfig(env: AiEnv = aiEnvFromProcess()) {
  return {
    model: env.CLOUDFLARE_TEXT_MODEL?.trim() || DEFAULT_TEXT_MODEL,
    timeoutMs: clampNumber(env.CLOUDFLARE_TEXT_TIMEOUT_MS, DEFAULT_TEXT_TIMEOUT_MS, MIN_TEXT_TIMEOUT_MS, MAX_TEXT_TIMEOUT_MS),
    maxTokens: Math.round(clampNumber(env.CLOUDFLARE_TEXT_MAX_TOKENS, DEFAULT_TEXT_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS))
  };
}

export function assertModelId(model: string) {
  if (!MODEL_ID.test(model)) throw new Error(`不支援的 Cloudflare 模型 ID：${model}`);
  return model;
}

function unwrapPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  if (record.success === false) {
    const errors = Array.isArray(record.errors) ? record.errors : [];
    const message = errors
      .map((error) => {
        if (!error || typeof error !== "object" || !("message" in error)) return "";
        return String((error as { message?: unknown }).message || "");
      })
      .filter(Boolean)
      .join("; ");
    throw new Error(message || "Cloudflare Workers AI 請求失敗。");
  }
  if ("result" in record && ("success" in record || "errors" in record)) return record.result;
  return payload;
}

export function workersAiText(payload: unknown) {
  const unwrapped = unwrapPayload(payload);
  if (typeof unwrapped === "string") return unwrapped;
  if (!unwrapped || typeof unwrapped !== "object") return "";
  const record = unwrapped as Record<string, unknown>;
  if (record.response && typeof record.response === "object") return JSON.stringify(record.response);
  if (record.result && typeof record.result === "object") return JSON.stringify(record.result);
  if (typeof record.response === "string") return record.response;
  if (typeof record.result === "string") return record.result;
  const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
  if (choice && typeof choice === "object") {
    const content = (choice as { message?: { content?: unknown } }).message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (!part || typeof part !== "object") return "";
        const text = (part as { text?: unknown; content?: unknown }).text ?? (part as { content?: unknown }).content;
        return typeof text === "string" ? text : "";
      }).join("\n");
    }
  }
  return "";
}

export function workersAiJson(payload: unknown): Record<string, unknown> | null {
  const unwrapped = unwrapPayload(payload);
  if (!unwrapped || typeof unwrapped !== "object") return null;
  const record = unwrapped as Record<string, unknown>;
  const candidate = record.response && typeof record.response === "object" ? record.response
    : record.result && typeof record.result === "object" ? record.result : record;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  return ("items" in value || "food" in value || "totalCalories" in value) ? value : null;
}

export function workersAiUsage(payload: unknown) {
  const unwrapped = unwrapPayload(payload);
  if (!unwrapped || typeof unwrapped !== "object" || !("usage" in unwrapped)) return null;
  return (unwrapped as { usage?: unknown }).usage ?? null;
}

async function runRest(model: string, input: Record<string, unknown>, env: AiEnv, timeoutMs: number) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() || "";
  const token = env.CLOUDFLARE_API_TOKEN?.trim() || "";
  if (!accountId || !token) throw new Error(MISSING_AI_CONFIG_ERROR);
  const response = await fetch(
    workersAiRunUrl(accountId, model),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs)
    }
  );
  const payload = await response.json().catch(() => null);
  const record = payload && typeof payload === "object"
    ? payload as { success?: boolean; errors?: { message?: string }[]; error?: { message?: string } }
    : {};
  if (!response.ok || record.success === false) {
    const message = record.errors?.[0]?.message || record.error?.message || "請求失敗";
    throw new Error(`Cloudflare Workers AI HTTP ${response.status}: ${message}`);
  }
  return payload;
}

export async function runWorkersAi(model: string, input: Record<string, unknown>, env: AiEnv, timeoutMs: number) {
  assertModelId(model);
  if (!hasWorkersAi(env)) throw new Error(MISSING_AI_CONFIG_ERROR);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Cloudflare Workers AI 模型 ${model} 逾時（${timeoutMs}ms）。`);
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
  });

  try {
    const pending = env.AI ? env.AI.run(model, input) : runRest(model, input, env, timeoutMs);
    return await Promise.race([pending, timeout]);
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`Cloudflare Workers AI 模型 ${model} 逾時（${timeoutMs}ms）。`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
