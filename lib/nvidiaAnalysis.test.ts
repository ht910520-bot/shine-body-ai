import assert from "node:assert/strict";
import imageHandler from "../api/analyze-food.ts";
import textHandler from "../api/analyze-food-text.ts";
import {
  DEFAULT_NVIDIA_VISION_MAX_TOKENS,
  DEFAULT_NVIDIA_VISION_MODELS,
  DEFAULT_NVIDIA_VISION_TIMEOUT_MS,
  DEFAULT_NVIDIA_VISION_TOTAL_TIMEOUT_MS,
  MISSING_NVIDIA_KEY_ERROR,
  analyzeFoodImage,
  visionRuntimeConfig
} from "./analyzeFoodImage.ts";
import {
  DEFAULT_NVIDIA_TEXT_MAX_TOKENS,
  DEFAULT_NVIDIA_TEXT_MODEL,
  DEFAULT_NVIDIA_TEXT_TIMEOUT_MS,
  analyzeFoodText,
  textRuntimeConfig
} from "./analyzeFoodText.ts";

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const envKeys = [
  "NVIDIA_API_KEY",
  "NVIDIA_DEEPSEEK_API_KEY",
  "NVIDIA_VISION_MODEL",
  "NVIDIA_VISION_MODELS",
  "NVIDIA_VISION_FALLBACK_MODELS",
  "NVIDIA_VISION_FALLBACK_MODEL",
  "NVIDIA_VISION_TIMEOUT_MS",
  "NVIDIA_VISION_TOTAL_TIMEOUT_MS",
  "NVIDIA_VISION_MAX_TOKENS",
  "NVIDIA_MODEL",
  "NVIDIA_TEXT_TIMEOUT_MS",
  "NVIDIA_TEXT_MAX_TOKENS",
  "GEMINI_API_KEY"
] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

function clearNvidiaEnv() {
  for (const key of envKeys) delete process.env[key];
}

function mockResponse() {
  const res = {
    statusCode: 0,
    body: null as any,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    }
  };
  return res;
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

function textJson() {
  return JSON.stringify({
    status: "complete",
    question: "",
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

const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  clearNvidiaEnv();
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
  }
}

await check("vision defaults drop retired and slow models", () => {
  assert.deepEqual(visionRuntimeConfig().models, [
    "minimaxai/minimax-m3.1-flash",
    "meta/muse-glimmer-30b",
    "meta/llama-3.2-90b-vision-instruct"
  ]);
  assert.equal(DEFAULT_NVIDIA_VISION_MODELS.includes("nvidia/llama-3.1-nemotron-nano-vl-8b-v1"), false);
  assert.equal(DEFAULT_NVIDIA_VISION_MODELS.includes("meta/llama-3.2-11b-vision-instruct"), false);
  assert.equal(visionRuntimeConfig().timeoutMs, DEFAULT_NVIDIA_VISION_TIMEOUT_MS);
  assert.equal(DEFAULT_NVIDIA_VISION_TIMEOUT_MS, 45_000);
  assert.equal(visionRuntimeConfig().totalTimeoutMs, DEFAULT_NVIDIA_VISION_TOTAL_TIMEOUT_MS);
  assert.equal(DEFAULT_NVIDIA_VISION_TOTAL_TIMEOUT_MS, 55_000);
  assert.equal(visionRuntimeConfig().maxTokens, DEFAULT_NVIDIA_VISION_MAX_TOKENS);
  assert.equal(DEFAULT_NVIDIA_VISION_MAX_TOKENS, 3_000);
});

await check("vision env overrides stay inside the new clamps", () => {
  process.env.NVIDIA_VISION_MODELS = "minimaxai/minimax-m3.1-flash,meta/muse-glimmer-30b";
  process.env.NVIDIA_VISION_TIMEOUT_MS = "25000";
  process.env.NVIDIA_VISION_TOTAL_TIMEOUT_MS = "50000";
  process.env.NVIDIA_VISION_MAX_TOKENS = "3000";
  const config = visionRuntimeConfig();
  assert.deepEqual(config.models, ["minimaxai/minimax-m3.1-flash", "meta/muse-glimmer-30b"]);
  assert.equal(config.timeoutMs, 25_000);
  assert.equal(config.totalTimeoutMs, 50_000);
  assert.equal(config.maxTokens, 3_000);

  process.env.NVIDIA_VISION_TIMEOUT_MS = "90000";
  process.env.NVIDIA_VISION_TOTAL_TIMEOUT_MS = "90000";
  process.env.NVIDIA_VISION_MAX_TOKENS = "20";
  const clamped = visionRuntimeConfig();
  assert.equal(clamped.timeoutMs, 50_000);
  assert.equal(clamped.totalTimeoutMs, 55_000);
  assert.equal(clamped.maxTokens, 256);
});

await check("text default is a listed non-reasoning model", () => {
  const config = textRuntimeConfig();
  assert.equal(config.model, DEFAULT_NVIDIA_TEXT_MODEL);
  assert.equal(DEFAULT_NVIDIA_TEXT_MODEL, "nvidia/mistral-nemo-minitron-8b-8k-instruct");
  assert.notEqual(config.model, "meta/llama-3.1-8b-instruct");
  assert.notEqual(config.model, "deepseek-ai/deepseek-v4-flash");
  assert.equal(config.timeoutMs, DEFAULT_NVIDIA_TEXT_TIMEOUT_MS);
  assert.equal(config.maxTokens, DEFAULT_NVIDIA_TEXT_MAX_TOKENS);
  process.env.NVIDIA_MODEL = "ibm/granite-3.0-8b-instruct";
  process.env.NVIDIA_TEXT_TIMEOUT_MS = "40000";
  process.env.NVIDIA_TEXT_MAX_TOKENS = "9000";
  const overridden = textRuntimeConfig();
  assert.equal(overridden.model, "ibm/granite-3.0-8b-instruct");
  assert.equal(overridden.timeoutMs, 25_000);
  assert.equal(overridden.maxTokens, 4_096);
});

await check("empty vision content with finish_reason length reports usage", async () => {
  process.env.NVIDIA_API_KEY = "test-key";
  process.env.NVIDIA_VISION_MODELS = "minimaxai/minimax-m3.1-flash";
  const warnings: string[] = [];
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: "length", message: { content: "" } }],
    usage: { completion_tokens: 700, completion_tokens_details: { reasoning_tokens: 699 } }
  }), { status: 200 });

  await assert.rejects(
    () => analyzeFoodImage("abc", "image/jpeg"),
    /NVIDIA Vision 模型 minimaxai\/minimax-m3\.1-flash 未回傳文字內容（finish_reason=length/
  );
  assert.match(warnings.join("\n"), /finish_reason=length/);
  assert.match(warnings.join("\n"), /reasoning_tokens.:699/);
});

await check("vision request sends 3000 max tokens and keeps the first success", async () => {
  process.env.NVIDIA_API_KEY = "test-key";
  process.env.NVIDIA_VISION_MODELS = "minimaxai/minimax-m3.1-flash,meta/muse-glimmer-30b";
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: mealJson() } }],
      usage: { completion_tokens: 180 }
    }), { status: 200 });
  };
  const result = await analyzeFoodImage("abc", "image/jpeg");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, "minimaxai/minimax-m3.1-flash");
  assert.equal(bodies[0].max_tokens, 3_000);
  assert.equal(bodies[0].chat_template_kwargs, undefined);
  assert.equal(result.food.calories, 720);
  assert.match(result.provider, /minimaxai\/minimax-m3\.1-flash/);
});

await check("vision falls through and returns the last model error", async () => {
  process.env.NVIDIA_DEEPSEEK_API_KEY = "test-key";
  process.env.NVIDIA_VISION_MODELS = "retired-model,meta/muse-glimmer-30b";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "model retired" } }), { status: 410 });
    }
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { content: "" } }],
      usage: { completion_tokens: 3000 }
    }), { status: 200 });
  };
  await assert.rejects(
    () => analyzeFoodImage("abc"),
    /NVIDIA Vision 模型 meta\/muse-glimmer-30b 未回傳文字內容（finish_reason=length/
  );
  assert.equal(calls, 2);
});

await check("photo route ignores a Gemini key and names the NVIDIA failure", async () => {
  process.env.GEMINI_API_KEY = "invalid-gemini";
  const missing = mockResponse();
  await imageHandler({ method: "POST", body: { image: "abc" } }, missing);
  assert.equal(missing.statusCode, 500);
  assert.equal(missing.body.error, MISSING_NVIDIA_KEY_ERROR);
  assert.equal(missing.body.error.includes("GEMINI"), false);

  process.env.NVIDIA_API_KEY = "test-key";
  process.env.NVIDIA_VISION_MODELS = "minimaxai/minimax-m3.1-flash";
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: "length", message: { content: null } }],
    usage: { completion_tokens: 3000, completion_tokens_details: { reasoning_tokens: 3000 } }
  }), { status: 200 });
  const failed = mockResponse();
  await imageHandler({ method: "POST", body: { image: "abc", mimeType: "image/png" } }, failed);
  assert.equal(failed.statusCode, 500);
  assert.match(failed.body.error, /^AI 照片分析失敗: NVIDIA Vision 模型 minimaxai\/minimax-m3\.1-flash/);
  assert.equal(failed.body.error.includes("Gemini"), false);
  assert.equal(failed.body.error.includes("GEMINI"), false);
});

await check("text route reports reasoning exhaustion and does not call Gemini", async () => {
  process.env.GEMINI_API_KEY = "invalid-gemini";
  const missing = mockResponse();
  await textHandler({ method: "POST", body: { text: "雞胸肉便當" } }, missing);
  assert.equal(missing.statusCode, 500);
  assert.match(missing.body.error, /NVIDIA_API_KEY/);
  assert.equal(missing.body.error.includes("GEMINI"), false);

  process.env.NVIDIA_API_KEY = "test-key";
  const warnings: string[] = [];
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  let requestedModel = "";
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requestedModel = body.model;
    assert.equal(body.max_tokens, 1_200);
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { content: "" } }],
      usage: { completion_tokens: 1200, completion_tokens_details: { reasoning_tokens: 1200 } }
    }), { status: 200 });
  };
  const failed = mockResponse();
  await textHandler({ method: "POST", body: { text: "雞胸肉便當" } }, failed);
  assert.equal(requestedModel, DEFAULT_NVIDIA_TEXT_MODEL);
  assert.match(failed.body.error, /AI 飲食查詢失敗: NVIDIA 文字模型 .*finish_reason=length/);
  assert.match(warnings.join("\n"), /finish_reason=length/);
  assert.match(warnings.join("\n"), /reasoning_tokens.:1200/);

  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content: textJson() } }]
  }), { status: 200 });
  const ok = mockResponse();
  await textHandler({ method: "POST", body: { text: "雞胸肉便當" } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.food.name, "雞胸肉便當");
  assert.deepEqual(ok.body.sources, []);
});

await check("direct text analysis without a key fails before fetch", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 500 });
  };
  await assert.rejects(() => analyzeFoodText("湯"), /NVIDIA_API_KEY 或 NVIDIA_DEEPSEEK_API_KEY/);
  assert.equal(called, false);
});

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("nvidia analysis tests passed");
