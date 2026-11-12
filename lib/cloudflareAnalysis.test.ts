import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleWorkerRequest } from "./workerApp.ts";
import {
  ANALYSIS_LIMIT,
  handleAnalyzeFood,
  handleAnalyzeFoodText,
  handleLogin,
  resetRateLimits
} from "./apiRoutes.ts";
import { authorizeRequest } from "./accessGate.ts";
import {
  DEFAULT_TEXT_MODEL,
  DEFAULT_VISION_FALLBACK_MODELS,
  DEFAULT_VISION_MAX_TOKENS,
  DEFAULT_VISION_MODEL,
  DEFAULT_VISION_TIMEOUT_MS,
  MISSING_AI_CONFIG_ERROR,
  textRuntimeConfig,
  visionRuntimeConfig
} from "./cloudflareAi.ts";
import { analyzeFoodImage } from "./analyzeFoodImage.ts";
import { analyzeFoodText } from "./analyzeFoodText.ts";
import { sessionTokenFor } from "./sessionAuth.ts";

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const failures: string[] = [];

function mealJson() {
  return JSON.stringify({
    items: [
      { name: "白醬四種起司披薩", portion: "3片", grams: 240, calories: 760, protein: 32, carbs: 68, fat: 40 },
      { name: "法式布丁塔", portion: "1片", grams: 140, calories: 430, protein: 9, carbs: 48, fat: 22 },
      { name: "白開水", portion: "1杯", grams: 250, calories: 0, protein: 0, carbs: 0, fat: 0 }
    ],
    totalCalories: 999,
    confidence: "high",
    notes: "依盤面可見份量估算",
    food: {
      name: "照片餐點",
      calories: 999,
      protein: 10,
      carbs: 10,
      fat: 10,
      description: "依照片可見份量估算"
    }
  });
}

function textJson(status = "complete", question = "") {
  return JSON.stringify({
    status,
    question,
    food: {
      name: "雞胸肉便當",
      calories: status === "needs_confirmation" ? 540 : 540,
      protein: 40,
      carbs: 60,
      fat: 12,
      description: "白飯一碗、雞胸無炸"
    },
    confidence: "medium",
    notes: "份量假設"
  });
}

async function check(name: string, fn: () => void | Promise<void>) {
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
    resetRateLimits();
  }
}

await check("login cookie is still the SHA-256 of the existing access code", async () => {
  const accessCode = "existing-app-password";
  assert.equal(sessionTokenFor(accessCode), createHash("sha256").update(accessCode).digest("hex"));
  const response = await handleLogin(new Request("https://shine.example/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "login-ok" },
    body: JSON.stringify({ password: accessCode })
  }), { APP_ACCESS_CODE: accessCode });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") || "", new RegExp(`shine_auth=${sessionTokenFor(accessCode)}`));
  assert.match(response.headers.get("set-cookie") || "", /HttpOnly/);

  const rejected = await handleLogin(new Request("https://shine.example/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "login-bad" },
    body: JSON.stringify({ password: "different-password" })
  }), { APP_ACCESS_CODE: accessCode });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get("set-cookie"), null);
});

await check("pages stay behind the same login gate", async () => {
  const accessCode = "gate-code";
  const env = {
    APP_ACCESS_CODE: accessCode,
    ASSETS: { fetch: async () => new Response("spa", { status: 200, headers: { "content-type": "text/html" } }) }
  };
  const redirect = await handleWorkerRequest(new Request("https://shine.example/diary?day=1"), env);
  assert.equal(redirect.status, 303);
  const location = redirect.headers.get("location") || "";
  assert.match(location, /\/login\.html\?next=/);
  assert.match(decodeURIComponent(location), /\/diary\?day=1/);

  const api = await handleWorkerRequest(new Request("https://shine.example/api/data"), env);
  assert.equal(api.status, 401);
  assert.equal((await api.json()).error, "請先登入。");

  const health = await handleWorkerRequest(new Request("https://shine.example/api/health"), env);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).platform, "cloudflare");

  const authed = await handleWorkerRequest(new Request("https://shine.example/diary", {
    headers: { cookie: `shine_auth=${sessionTokenFor(accessCode)}` }
  }), env);
  assert.equal(authed.status, 200);
  assert.equal(await authed.text(), "spa");
  assert.equal(authorizeRequest(new Request("https://shine.example/login.html"), accessCode), null);
  assert.equal(authorizeRequest(new Request("https://shine.example/login"), accessCode), null);
});

await check("vision defaults, fallback chain, deduplication and clamps use Workers AI models", () => {
  const defaults = visionRuntimeConfig({});
  assert.equal(defaults.model, DEFAULT_VISION_MODEL);
  assert.equal(DEFAULT_VISION_MODEL, "@cf/google/gemma-4-26b-a4b-it");
  assert.equal(DEFAULT_VISION_FALLBACK_MODELS, "@cf/mistralai/mistral-small-3.1-24b-instruct,@cf/meta/llama-3.2-11b-vision-instruct");
  assert.deepEqual(defaults.models, [
    "@cf/google/gemma-4-26b-a4b-it",
    "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "@cf/meta/llama-3.2-11b-vision-instruct"
  ]);
  assert.deepEqual(defaults.fallbackModels, [
    "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "@cf/meta/llama-3.2-11b-vision-instruct"
  ]);
  assert.equal(defaults.maxTokens, DEFAULT_VISION_MAX_TOKENS);
  assert.equal(defaults.maxTokens, 1_500);
  assert.equal(defaults.timeoutMs, DEFAULT_VISION_TIMEOUT_MS);
  assert.equal(defaults.timeoutMs, 30_000);

  const deduped = visionRuntimeConfig({
    CLOUDFLARE_VISION_MODEL: "@cf/mistralai/mistral-small-3.1-24b-instruct",
    CLOUDFLARE_VISION_FALLBACK_MODELS: "@cf/mistralai/mistral-small-3.1-24b-instruct, @cf/meta/llama-3.2-11b-vision-instruct , @cf/meta/llama-3.2-11b-vision-instruct",
    CLOUDFLARE_VISION_MAX_TOKENS: "20",
    CLOUDFLARE_VISION_TIMEOUT_MS: "90000"
  });
  assert.equal(deduped.model, "@cf/mistralai/mistral-small-3.1-24b-instruct");
  assert.deepEqual(deduped.models, [
    "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "@cf/meta/llama-3.2-11b-vision-instruct"
  ]);
  assert.equal(deduped.maxTokens, 256);
  assert.equal(deduped.timeoutMs, 55_000);

  assert.throws(
    () => visionRuntimeConfig({ CLOUDFLARE_VISION_FALLBACK_MODELS: "invalid-model-id" }),
    /不支援的 Cloudflare 模型 ID/
  );

  assert.equal(textRuntimeConfig().model, DEFAULT_TEXT_MODEL);
  assert.equal(DEFAULT_TEXT_MODEL, "@cf/meta/llama-3.1-8b-instruct-fast");
  assert.equal(textRuntimeConfig({ CLOUDFLARE_TEXT_MAX_TOKENS: "9000" }).maxTokens, 4_096);
  assert.equal(textRuntimeConfig({ CLOUDFLARE_TEXT_TIMEOUT_MS: "1000" }).timeoutMs, 3_000);
});

await check("REST credentials are preferred over the AI binding and use single-stage gemma vision JSON", async () => {
  let restCalls = 0;
  let bindingCalls = 0;
  globalThis.fetch = async (input, init) => {
    restCalls += 1;
    assert.match(String(input), /@cf\/google\/gemma-4-26b-a4b-it$/);
    const body = JSON.parse(String(init?.body || "{}"));
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.response_format?.type, "json_schema");
    assert.ok(body.response_format?.json_schema);
    assert.equal(body.messages?.[1]?.content?.[1]?.image_url?.url, "data:image/png;base64,abc");
    return new Response(JSON.stringify({
      success: true,
      result: { choices: [{ message: { content: mealJson() } }] }
    }), { status: 200 });
  };
  const result = await analyzeFoodImage("abc", "image/png", {
    AI: {
      async run() {
        bindingCalls += 1;
        throw new Error("binding should not run when REST credentials exist");
      }
    },
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_API_TOKEN: "secret-token"
  });
  assert.equal(restCalls, 1);
  assert.equal(bindingCalls, 0);
  assert.equal(result.items.length, 2);
  assert.equal(result.totalCalories, 1190);
  assert.equal(result.food.calories, 1190);
  assert.equal(result.food.protein, 41);
  assert.equal(result.food.carbs, 116);
  assert.equal(result.food.fat, 62);
  assert.equal(result.food.name, "白醬四種起司披薩、法式布丁塔");
  assert.match(result.food.description, /白醬四種起司披薩（3片，約 240g）/);
  assert.match(result.food.description, /法式布丁塔（1片，約 140g）/);
  assert.equal(result.provider, "Cloudflare Workers AI (@cf/google/gemma-4-26b-a4b-it)");
  assert.match(result.notes, /Cloudflare Workers AI/);
});

await check("REST is the fallback and keeps needs_confirmation", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 500 });
  };
  await assert.rejects(
    () => analyzeFoodText("湯", undefined, undefined, {}),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /CLOUDFLARE_ACCOUNT_ID/);
      return true;
    }
  );
  assert.equal(called, false);

  globalThis.fetch = async (input, init) => {
    called = true;
    const url = String(input);
    assert.match(url, /\/accounts\/account-id\/ai\/run\/@cf\/meta\/llama-3\.1-8b-instruct-fast$/);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer rest-token");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_tokens, 1_200);
    assert.match(body.messages[1].content, /needs_confirmation/);
    return new Response(JSON.stringify({
      success: true,
      result: { response: textJson("needs_confirmation", "飯量是正常一碗嗎？") }
    }), { status: 200 });
  };
  const result = await analyzeFoodText("雞胸肉便當", undefined, undefined, {
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    CLOUDFLARE_API_TOKEN: "rest-token"
  });
  assert.equal(called, true);
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.question, "飯量是正常一碗嗎？");
  assert.deepEqual(result.sources, []);
  assert.match(result.notes, /未連接即時網路搜尋/);
});

await check("photo route reports an empty model response and blocks zero calories without doubled prefix", async () => {
  const missing = await handleAnalyzeFood(new Request("https://shine.example/api/analyze-food", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "photo-missing" },
    body: JSON.stringify({ image: "abc" })
  }), {});
  assert.equal(missing.status, 500);
  assert.equal((await missing.json()).error, MISSING_AI_CONFIG_ERROR);

  const env = {
    AI: {
      async run() {
        return { response: "" };
      }
    }
  };
  const empty = await handleAnalyzeFood(new Request("https://shine.example/api/analyze-food", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "photo-empty" },
    body: JSON.stringify({ image: "abc", mimeType: "image/jpeg" })
  }), env);
  assert.equal(empty.status, 500);
  const emptyError = (await empty.json()).error as string;
  assert.match(emptyError, /^AI 照片分析失敗：所有模型都沒有回傳可用的結果/);
  assert.equal(emptyError.includes("AI 照片分析失敗: AI 照片分析失敗"), false);
  assert.match(emptyError, /未回傳文字內容/);

  const zero = await handleAnalyzeFood(new Request("https://shine.example/api/analyze-food", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "photo-zero" },
    body: JSON.stringify({ image: "abc" })
  }), {
    AI: {
      async run() {
        return { response: JSON.stringify({ food: { calories: 0 }, totalCalories: 0, items: [] }) };
      }
    }
  });
  const zeroError = (await zero.json()).error as string;
  assert.match(zeroError, /0 kcal/);
  assert.equal(zeroError.includes("AI 照片分析失敗: AI 照片分析失敗"), false);
});

await check("analysis stays near twenty requests per hour per client", async () => {
  let calls = 0;
  const env = {
    AI: {
      async run() {
        calls += 1;
        return { response: textJson() };
      }
    }
  };
  for (let index = 0; index < ANALYSIS_LIMIT; index += 1) {
    const response = await handleAnalyzeFoodText(new Request("https://shine.example/api/analyze-food-text", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "rate-client" },
      body: JSON.stringify({ text: "雞胸肉便當" })
    }), env);
    assert.equal(response.status, 200);
  }
  const limited = await handleAnalyzeFoodText(new Request("https://shine.example/api/analyze-food-text", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "rate-client" },
    body: JSON.stringify({ text: "雞胸肉便當" })
  }), env);
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /一小時/);
  assert.equal(calls, ANALYSIS_LIMIT);
});

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("cloudflare analysis tests passed");
