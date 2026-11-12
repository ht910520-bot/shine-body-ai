import assert from "node:assert/strict";
import { handleAnalyzeFood, handleAnalyzeFoodText, resetRateLimits } from "./apiRoutes.ts";
import {
  VISION_RETRY_REMINDER,
  VISION_USER_PROMPT,
  analyzeFoodImage,
  normalizeResult
} from "./analyzeFoodImage.ts";
import { analyzeFoodText } from "./analyzeFoodText.ts";
import {
  DEFAULT_TEXT_MAX_TOKENS,
  DEFAULT_TEXT_MODEL,
  DEFAULT_TEXT_TIMEOUT_MS,
  DEFAULT_VISION_FALLBACK_MODELS,
  DEFAULT_VISION_MAX_TOKENS,
  DEFAULT_VISION_MODEL,
  DEFAULT_VISION_TIMEOUT_MS,
  MISSING_AI_CONFIG_ERROR,
  aiEnvFromProcess,
  textRuntimeConfig,
  visionRuntimeConfig,
  workersAiRunUrl,
  workersAiJson,
  workersAiText
} from "./cloudflareAi.ts";
import { parseModelJson } from "./modelJson.ts";

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const envKeys = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_AUTH_TOKEN",
  "CLOUDFLARE_VISION_MODEL",
  "CLOUDFLARE_VISION_FALLBACK_MODELS",
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
    items: [
      { name: "白醬起司披薩", portion: "半份", grams: 220, calories: 680, protein: 28, carbs: 64, fat: 34 },
      { name: "法式鹹派", portion: "一片", grams: 130, calories: 490, protein: 14, carbs: 32, fat: 33 }
    ],
    totalCalories: 1170,
    confidence: "high",
    notes: "依盤面可見大小估算",
    food: {
      name: "白醬起司披薩、法式鹹派",
      calories: 1170,
      protein: 42,
      carbs: 96,
      fat: 67,
      description: "白醬起司披薩（半份，約 220g）、法式鹹派（一片，約 130g）"
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

function workersChatResult(content: string) {
  return new Response(JSON.stringify({
    success: true,
    errors: [],
    result: { choices: [{ message: { content } }] }
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

await check("model JSON extraction handles object input, middle fences, prose, trailing commas, and bad blocks", () => {
  const preParsed = { items: [{ name: "法式鹹派", calories: 450 }], totalCalories: 450 };
  assert.equal(parseModelJson(preParsed), preParsed);

  assert.deepEqual(
    parseModelJson("Here is the estimate:\n```json\n{\"food\":{\"name\":\"牛排\"}}\n```"),
    { food: { name: "牛排" } }
  );

  assert.deepEqual(
    parseModelJson("分析完成，請參考以下結果：\n```json\n{\n  \"items\": [\n    { \"name\": \"法式布丁塔\", \"calories\": 420, },\n  ],\n  \"totalCalories\": 420,\n}\n```\n祝您用餐愉快！"),
    { items: [{ name: "法式布丁塔", calories: 420 }], totalCalories: 420 }
  );

  assert.deepEqual(
    parseModelJson("前言說明 {這不是合法JSON} 真正的物件如下：{\"food\":{\"name\":\"滷肉飯, 加蛋\",\"calories\":520,},} 後記文字。"),
    { food: { name: "滷肉飯, 加蛋", calories: 520 } }
  );

  assert.throws(() => parseModelJson("- 牛排\n- 馬鈴薯"), /^Error: AI 沒有回傳可讀取的 JSON。$/);
  assert.throws(() => parseModelJson(""), /AI 沒有回傳可讀取的 JSON。/);
  assert.throws(() => parseModelJson("[1, 2, 3]"), /AI 沒有回傳可讀取的 JSON。/);
  assert.throws(() => parseModelJson(null), /AI 沒有回傳可讀取的 JSON。/);

  const object = { items: [], totalCalories: 100, food: { name: "牛排", calories: 100 } };
  assert.equal(workersAiText("plain response"), "plain response");
  assert.equal(workersAiText({ response: "bound response" }), "bound response");
  assert.equal(workersAiJson({ response: object })?.totalCalories, 100);
  assert.equal(workersAiText({ choices: [{ message: { content: "chat response" } }] }), "chat response");
  assert.equal(workersAiJson({ choices: [{ message: { content: object } }] })?.totalCalories, 100);
  assert.equal(workersAiText({ success: true, result: { response: "rest response" } }), "rest response");
  assert.equal(workersAiJson({ success: true, result: { response: object } })?.totalCalories, 100);
});

await check("vision prompt and normalizeResult enforce item totals, water filtering, and neutral examples", () => {
  assert.match(VISION_USER_PROMPT, /一碗/);
  assert.match(VISION_USER_PROMPT, /半份/);
  assert.match(VISION_USER_PROMPT, /一片/);
  assert.match(VISION_USER_PROMPT, /quiche/i);
  assert.match(VISION_USER_PROMPT, /flan/i);
  assert.equal(/披薩|pizza/i.test(VISION_USER_PROMPT), false);

  const normalized = normalizeResult({
    items: [
      { name: "白醬四種起司山羊起司薄餅", portion: "半份", grams: 240, calories: 780, protein: 31.4, carbs: 66.2, fat: 42.1 },
      { name: "法式布丁塔", portion: "一片", grams: 135, calories: 410, protein: 8.6, carbs: 45.8, fat: 20.9 },
      { name: "冰開水", portion: "一杯", grams: 300, calories: 0, protein: 0, carbs: 0, fat: 0 }
    ],
    totalCalories: 500,
    confidence: "high",
    notes: "已排除水杯與收據",
    food: {
      name: "餐點",
      calories: 500,
      protein: 10,
      carbs: 10,
      fat: 10,
      description: ""
    }
  });

  assert.equal(normalized.items.length, 2);
  assert.equal(normalized.totalCalories, 1190);
  assert.equal(normalized.food.calories, 1190);
  assert.equal(normalized.food.protein, 40);
  assert.equal(normalized.food.carbs, 112);
  assert.equal(normalized.food.fat, 63);
  assert.equal(normalized.food.name, "白醬四種起司山羊起司薄餅、法式布丁塔");
  assert.equal(
    normalized.food.description,
    "白醬四種起司山羊起司薄餅（半份，約 240g）、法式布丁塔（一片，約 135g）"
  );
});

await check("vision retries bad JSON once on the same model with the short reminder", async () => {
  const calls: Array<{ model: string; input: Record<string, any> }> = [];
  const warnings: Array<Record<string, any>> = [];
  console.warn = (msg?: unknown) => {
    warnings.push(JSON.parse(String(msg)));
  };

  const result = await analyzeFoodImage("photo-bytes", "image/jpeg", {
    AI: {
      async run(model, input) {
        calls.push({ model, input });
        if (calls.length === 1) {
          return { choices: [{ message: { content: "這是一份美味的餐點，但沒有輸出 JSON" } }] };
        }
        return { choices: [{ message: { content: mealJson() } }] };
      }
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, DEFAULT_VISION_MODEL);
  assert.equal(calls[1].model, DEFAULT_VISION_MODEL);
  assert.deepEqual(calls[0].input.chat_template_kwargs, { enable_thinking: false });
  assert.equal(calls[0].input.response_format?.type, "json_schema");
  assert.equal(
    calls[0].input.messages[1].content[1].image_url.url,
    "data:image/jpeg;base64,photo-bytes"
  );
  assert.equal(calls[0].input.messages[1].content[0].text.includes(VISION_RETRY_REMINDER), false);
  assert.equal(calls[1].input.messages[1].content[0].text.includes(VISION_RETRY_REMINDER), true);
  assert.equal(result.totalCalories, 1170);
  assert.equal(result.provider, `Cloudflare Workers AI (${DEFAULT_VISION_MODEL})`);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, "workers_ai_vision_attempt_failed");
  assert.equal(warnings[0].model, DEFAULT_VISION_MODEL);
  assert.equal(warnings[0].attempt, 1);
  assert.equal(warnings[0].sample.includes("photo-bytes"), false);
});

await check("vision fallback order handles thrown errors, response_format rejection, and legacy llama-3.2 shape", async () => {
  const calls: Array<{ model: string; input: Record<string, any> }> = [];
  const result = await analyzeFoodImage("secret-image-base64", "image/png", {
    AI: {
      async run(model, input) {
        calls.push({ model, input });
        if (model === "@cf/google/gemma-4-26b-a4b-it") {
          throw new Error("3030: Internal Server Error");
        }
        if (model === "@cf/mistralai/mistral-small-3.1-24b-instruct") {
          if (input.response_format) {
            throw new Error("response_format json_schema is unsupported for this model");
          }
          return { choices: [{ message: { content: "完全無法解析的文字" } }] };
        }
        assert.equal(model, "@cf/meta/llama-3.2-11b-vision-instruct");
        assert.equal(input.image, "data:image/png;base64,secret-image-base64");
        assert.equal(typeof input.prompt, "string");
        assert.equal("messages" in input, false);
        return { response: mealJson() };
      }
    }
  });

  // gemma throws 3030 -> 1 call (no retry on thrown error)
  // mistral rejects response_format -> retries attempt 1 without response_format -> returns bad JSON -> attempt 2 without response_format -> returns bad JSON (3 calls total on mistral)
  // llama-3.2 succeeds on attempt 1 (1 call)
  assert.deepEqual(calls.map((c) => c.model), [
    "@cf/google/gemma-4-26b-a4b-it",
    "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "@cf/mistralai/mistral-small-3.1-24b-instruct",
    "@cf/meta/llama-3.2-11b-vision-instruct"
  ]);
  assert.equal("response_format" in calls[1].input, true);
  assert.equal("response_format" in calls[2].input, false);
  assert.equal("response_format" in calls[3].input, false);
  assert.equal("chat_template_kwargs" in calls[1].input, false);
  assert.equal(result.provider, "Cloudflare Workers AI (@cf/meta/llama-3.2-11b-vision-instruct)");
  assert.equal(result.totalCalories, 1170);
});

await check("defaults are the Workers AI models", () => {
  assert.equal(visionRuntimeConfig().model, DEFAULT_VISION_MODEL);
  assert.equal(DEFAULT_VISION_MODEL, "@cf/google/gemma-4-26b-a4b-it");
  assert.equal(DEFAULT_VISION_FALLBACK_MODELS, "@cf/mistralai/mistral-small-3.1-24b-instruct,@cf/meta/llama-3.2-11b-vision-instruct");
  assert.equal(textRuntimeConfig().model, DEFAULT_TEXT_MODEL);
  assert.equal(DEFAULT_TEXT_MODEL, "@cf/meta/llama-3.1-8b-instruct-fast");
  assert.equal(DEFAULT_VISION_TIMEOUT_MS, 30_000);
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

await check("photo request uses single-stage vision JSON on primary model", async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct-1";
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  const urls: string[] = [];
  let auth = "";
  let body: any = null;
  globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    auth = new Headers(init?.headers).get("authorization") || "";
    body = JSON.parse(String(init?.body));
    assert.equal(init?.signal instanceof AbortSignal, true);
    return workersChatResult(mealJson());
  };
  const result = await analyzeFoodImage("abc", "image/jpeg");
  assert.deepEqual(urls, [workersAiRunUrl("acct-1", DEFAULT_VISION_MODEL)]);
  assert.equal(auth, "Bearer test-token");
  assert.equal(body.max_tokens, DEFAULT_VISION_MAX_TOKENS);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(result.food.calories, 1170);
  assert.equal(result.provider, `Cloudflare Workers AI (${DEFAULT_VISION_MODEL})`);
});

await check("CF_ACCOUNT_ID and CF_API_TOKEN are accepted aliases", async () => {
  process.env.CF_ACCOUNT_ID = "acct-alias";
  process.env.CF_API_TOKEN = "alias-token";
  let auth = "";
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    auth = new Headers(init?.headers).get("authorization") || "";
    return workersChatResult(mealJson());
  };
  await analyzeFoodImage("abc", "image/png");
  assert.deepEqual(urls, [workersAiRunUrl("acct-alias", DEFAULT_VISION_MODEL)]);
  assert.equal(auth, "Bearer alias-token");
});

await check("when all models fail, error summarizes each model and logs structured attempt warnings without image", async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct-1";
  process.env.CLOUDFLARE_AUTH_TOKEN = "auth-token";
  const warnings: string[] = [];
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("gemma-4-26b-a4b-it")) {
      return new Response(JSON.stringify({
        success: true,
        result: { choices: [{ message: { content: "   " } }] }
      }), { status: 200 });
    }
    if (url.includes("mistral-small-3.1-24b-instruct")) {
      return new Response(JSON.stringify({
        success: false,
        errors: [{ message: "3030: Internal Server Error" }]
      }), { status: 500 });
    }
    return new Response(JSON.stringify({
      success: false,
      errors: [{ message: "No such model" }]
    }), { status: 400 });
  };

  await assert.rejects(
    () => analyzeFoodImage("sensitive-image-payload"),
    (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      assert.match(msg, /^AI 照片分析失敗：所有模型都沒有回傳可用的結果/);
      assert.match(msg, /gemma-4-26b-a4b-it：JSON 無法解析（未回傳文字內容）/);
      assert.match(msg, /mistral-small-3\.1-24b-instruct：HTTP 500: 3030: Internal Server Error/);
      assert.match(msg, /llama-3\.2-11b-vision-instruct：HTTP 400: No such model/);
      assert.match(msg, /請稍後再試或改用文字輸入。$/);
      return true;
    }
  );
  assert.match(warnings.join("\n"), /workers_ai_vision_attempt_failed/);
  assert.equal(warnings.join("\n").includes("sensitive-image-payload"), false);
});

await check("zero calorie photos are retried and rejected when all models return 0 kcal", async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct-1";
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return workersChatResult(JSON.stringify({
      items: [],
      food: { name: "空盤", calories: 0, protein: 0, carbs: 0, fat: 0 },
      totalCalories: 0
    }));
  };
  await assert.rejects(() => analyzeFoodImage("abc"), /0 kcal/);
  // 3 models * 2 attempts each = 6 attempts
  assert.equal(calls, 6);
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

await check("upstream timeout falls through fallback chain and reports timeout without calling NVIDIA", async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct-1";
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  const attemptedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    attemptedUrls.push(String(input));
    const error = new Error("The operation was aborted");
    error.name = "TimeoutError";
    throw error;
  };
  await assert.rejects(
    () => analyzeFoodImage("abc"),
    new RegExp(`逾時（${DEFAULT_VISION_TIMEOUT_MS}ms）`)
  );
  assert.equal(attemptedUrls.length, 3);
});

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("workers ai analysis tests passed");
