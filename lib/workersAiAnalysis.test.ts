import assert from "node:assert/strict";
import { handleAnalyzeFood, handleAnalyzeFoodText, resetRateLimits } from "./apiRoutes.ts";
import { analyzeFoodImage } from "./analyzeFoodImage.ts";
import { analyzeFoodText } from "./analyzeFoodText.ts";
import {
  DEFAULT_TEXT_MAX_TOKENS,
  DEFAULT_TEXT_MODEL,
  DEFAULT_TEXT_TIMEOUT_MS,
  DEFAULT_VISION_MAX_TOKENS,
  DEFAULT_VISION_MODEL,
  DEFAULT_VISION_TIMEOUT_MS,
  MISSING_AI_CONFIG_ERROR,
  aiEnvFromProcess,
  textRuntimeConfig,
  visionRuntimeConfig,
  workersAiRunUrl
} from "./cloudflareAi.ts";

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const envKeys = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_AUTH_TOKEN",
  "CLOUDFLARE_VISION_MODEL",
  "CLOUDFLARE_TEXT_MODEL",
  "CF_ACCOUNT_ID",
  "CF_API_TOKEN",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY"
] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

function clearEnv() {
  for (const key of envKeys) delete process.env[key];
}

function mealJson() {
  return JSON.stringify({
    items: [{ name: "雞腿飯", calories: 720, protein: 32, carbs: 80, fat: 24 }],
    totalCalories: 720,
    confidence: "medium",
    notes: "白飯約一碗",
    food: {
      name: "雞腿飯",
      calories: 720,
      protein: 32,
      carbs: 80,
      fat: 24,
      description: "依照片可見份量估算"
    }
  });
}

function textJson(status = "complete") {
  return JSON.stringify({
    status,
    question: status === "needs_confirmation" ? "白飯大概多少？" : "",
    food: {
      name: "雞胸肉便當",
      calories: 540,
      protein: 40,
      carbs: 60,
      fat: 12,
      description: "白飯一碗、雞胸無炸"
    },
    confidence: "medium",
    notes: "份量假設"
  });
}

function workersResult(content: string) {
  return new Response(JSON.stringify({
    success: true,
    errors: [],
    result: { response: content }
  }), { status: 200 });
}

const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  clearEnv();
  resetRateLimits();
  console.warn = () => undefined;
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : error}`);
    console.error(`not ok ${name}`);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    restoreEnv();
    resetRateLimits();
  }
}

await check("defaults are the Workers AI models", () => {
  assert.equal(visionRuntimeConfig().model, DEFAULT_VISION_MODEL);
  assert.equal(DEFAULT_VISION_MODEL, "@cf/meta/llama-3.2-11b-vision-instruct");
  assert.equal(textRuntimeConfig().model, DEFAULT_TEXT_MODEL);
  assert.equal(DEFAULT_TEXT_MODEL, "@cf/meta/llama-3.1-8b-instruct-fast");
  assert.equal(DEFAULT_VISION_TIMEOUT_MS, 45_000);
  assert.ok(DEFAULT_VISION_TIMEOUT_MS < 60_000);
  assert.equal(DEFAULT_TEXT_TIMEOUT_MS, 20_000);
  assert.ok(DEFAULT_TEXT_TIMEOUT_MS < 30_000);
  assert.equal(visionRuntimeConfig().maxTokens, DEFAULT_VISION_MAX_TOKENS);
  assert.equal(textRuntimeConfig().maxTokens, DEFAULT_TEXT_MAX_TOKENS);
  process.env.CLOUDFLARE_VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
  process.env.CLOUDFLARE_TEXT_MODEL = "@cf/meta/llama-3.2-3b-instruct";
  assert.equal(visionRuntimeConfig().model, "@cf/meta/llama-4-scout-17b-16e-instruct");
  assert.equal(textRuntimeConfig().model, "@cf/meta/llama-3.2-3b-instruct");
});

await check("photo request posts to Workers AI with the vision model", async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct-1";
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  let url = "";
  let auth = "";
  let body: any = null;
  globalThis.fetch = async (input, init) => {
    url = String(input);
    auth = new Headers(init?.headers).get("authorization") || "";
    body = JSON.parse(String(init?.body));
    assert.equal(init?.signal instanceof AbortSignal, true);
    return workersResult(mealJson());
  };
  const result = await analyzeFoodImage("abc", "image/jpeg");
  assert.equal(url, workersAiRunUrl("acct-1", DEFAULT_VISION_MODEL));
  assert.equal(url.includes("integrate.api.nvidia.com"), false);
  assert.equal(auth, "Bearer test-token");
  assert.equal(body.image, "data:image/jpeg;base64,abc");
  assert.equal(body.max_tokens, DEFAULT_VISION_MAX_TOKENS);
  assert.equal(String(body.prompt).includes("JSON"), true);
  assert.equal(result.food.calories, 720);
  assert.equal(result.provider, `Cloudflare Workers AI (${DEFAULT_VISION_MODEL})`);
});

await check("CF_ACCOUNT_ID and CF_API_TOKEN are accepted aliases", async () => {
  process.env.CF_ACCOUNT_ID = "acct-alias";
  process.env.CF_API_TOKEN = "alias-token";
  let auth = "";
  let url = "";
  globalThis.fetch = async (input, init) => {
    url = String(input);
    auth = new Headers(init?.headers).get("authorization") || "";
    return workersResult(mealJson());
  };
  await analyzeFoodImage("abc", "image/png");
  assert.equal(url, workersAiRunUrl("acct-alias", DEFAULT_VISION_MODEL));
  assert.equal(auth, "Bearer alias-token");
});

await check("empty vision content and HTTP errors name Workers AI", async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct-1";
  process.env.CLOUDFLARE_AUTH_TOKEN = "auth-token";
  const warnings: string[] = [];
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: true,
    result: { response: "   ", usage: { completion_tokens: 0 } }
  }), { status: 200 });
  await assert.rejects(
    () => analyzeFoodImage("abc"),
    /Cloudflare Vision 模型 @cf\/meta\/llama-3\.2-11b-vision-instruct 未回傳文字內容/
  );
  assert.match(warnings.join("\n"), /workers_ai_empty_response/);

  globalThis.fetch = async () => new Response(JSON.stringify({
    success: false,
    errors: [{ message: "No such model" }]
  }), { status: 400 });
  await assert.rejects(() => analyzeFoodImage("abc"), /HTTP 400: No such model/);
});

await check("zero calorie photos are rejected", async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct-1";
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  globalThis.fetch = async () => workersResult(JSON.stringify({
    food: { name: "空盤", calories: 0, protein: 0, carbs: 0, fat: 0 },
    totalCalories: 0
  }));
  await assert.rejects(() => analyzeFoodImage("abc"), /0 kcal/);
});

await check("text request uses the fast instruct model and keeps needs_confirmation", async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct-1";
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  let url = "";
  let body: any = null;
  globalThis.fetch = async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body));
    return workersResult(textJson("needs_confirmation"));
  };
  const result = await analyzeFoodText("雞胸肉便當", "白飯正常", { food: { name: "便當" } });
  assert.equal(url, workersAiRunUrl("acct-1", DEFAULT_TEXT_MODEL));
  assert.equal(body.max_tokens, DEFAULT_TEXT_MAX_TOKENS);
  assert.equal(body.messages[1].content.includes("needs_confirmation"), true);
  assert.equal(body.messages[1].content.includes("NVIDIA"), false);
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.question, "白飯大概多少？");
  assert.deepEqual(result.sources, []);
  assert.match(result.provider, /llama-3\.1-8b-instruct-fast/);
});

await check("routes require Cloudflare credentials and return the model JSON", async () => {
  process.env.GEMINI_API_KEY = "invalid-gemini";
  process.env.NVIDIA_API_KEY = "leftover-nvidia";
  const missing = await handleAnalyzeFood(new Request("https://shine.example/api/analyze-food", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "rest-missing" },
    body: JSON.stringify({ image: "abc" })
  }), {});
  assert.equal(missing.status, 500);
  const missingBody = await missing.json();
  assert.equal(missingBody.error, MISSING_AI_CONFIG_ERROR);
  assert.equal(missingBody.error.includes("NVIDIA"), false);
  assert.equal(missingBody.error.includes("GEMINI"), false);

  const missingText = await handleAnalyzeFoodText(new Request("https://shine.example/api/analyze-food-text", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "rest-missing-text" },
    body: JSON.stringify({ text: "雞胸肉便當" })
  }), {});
  assert.equal((await missingText.json()).error, MISSING_AI_CONFIG_ERROR);

  process.env.CLOUDFLARE_ACCOUNT_ID = "acct-1";
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  globalThis.fetch = async () => workersResult(textJson());
  const ok = await handleAnalyzeFoodText(new Request("https://shine.example/api/analyze-food-text", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "rest-ok" },
    body: JSON.stringify({ text: "雞胸肉便當" })
  }), aiEnvFromProcess());
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.status, "complete");
  assert.equal(okBody.food.name, "雞胸肉便當");
  assert.deepEqual(okBody.sources, []);
});

await check("direct text analysis without a token fails before fetch", async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct-1";
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 500 });
  };
  await assert.rejects(() => analyzeFoodText("湯"), /CLOUDFLARE_ACCOUNT_ID/);
  assert.equal(called, false);
});

await check("upstream timeout is reported without calling NVIDIA", async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct-1";
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  globalThis.fetch = async () => {
    const error = new Error("The operation was aborted");
    error.name = "TimeoutError";
    throw error;
  };
  await assert.rejects(
    () => analyzeFoodImage("abc"),
    new RegExp(`逾時（${DEFAULT_VISION_TIMEOUT_MS}ms）`)
  );
});

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("workers ai analysis tests passed");
