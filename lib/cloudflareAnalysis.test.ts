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
  DEFAULT_VISION_MODEL,
  MISSING_AI_CONFIG_ERROR,
  textRuntimeConfig,
  visionRuntimeConfig
} from "./cloudflareAi.ts";
import { analyzeFoodImage } from "./analyzeFoodImage.ts";
import { analyzeFoodText } from "./analyzeFoodText.ts";
import { sessionTokenFor } from "./sessionAuth.ts";

const originalFetch = globalThis.fetch;
const failures: string[] = [];

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
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : error}`);
    console.error(`not ok ${name}`);
  } finally {
    globalThis.fetch = originalFetch;
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
});

await check("vision defaults and clamps use the Workers AI model", () => {
  assert.equal(visionRuntimeConfig().model, DEFAULT_VISION_MODEL);
  assert.equal(DEFAULT_VISION_MODEL, "@cf/meta/llama-3.2-11b-vision-instruct");
  assert.equal(visionRuntimeConfig().maxTokens, 2_048);
  assert.equal(visionRuntimeConfig({
    CLOUDFLARE_VISION_MODEL: "@cf/meta/llama-4-scout-17b-16e-instruct",
    CLOUDFLARE_VISION_MAX_TOKENS: "20",
    CLOUDFLARE_VISION_TIMEOUT_MS: "90000"
  }).model, "@cf/meta/llama-4-scout-17b-16e-instruct");
  assert.equal(visionRuntimeConfig({ CLOUDFLARE_VISION_MAX_TOKENS: "20" }).maxTokens, 256);
  assert.equal(visionRuntimeConfig({ CLOUDFLARE_VISION_TIMEOUT_MS: "90000" }).timeoutMs, 55_000);
  assert.equal(textRuntimeConfig().model, DEFAULT_TEXT_MODEL);
  assert.equal(DEFAULT_TEXT_MODEL, "@cf/meta/llama-3.1-8b-instruct-fast");
  assert.equal(textRuntimeConfig({ CLOUDFLARE_TEXT_MAX_TOKENS: "9000" }).maxTokens, 4_096);
  assert.equal(textRuntimeConfig({ CLOUDFLARE_TEXT_TIMEOUT_MS: "1000" }).timeoutMs, 3_000);
});

await check("the AI binding is preferred over the REST token", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("REST should not run");
  };
  let model = "";
  let image = "";
  const result = await analyzeFoodImage("abc", "image/png", {
    AI: {
      async run(nextModel, input) {
        model = nextModel;
        image = String(input.image);
        assert.equal(input.max_tokens, 2_048);
        assert.equal(typeof input.prompt, "string");
        return { response: mealJson() };
      }
    },
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_API_TOKEN: "secret-token"
  });
  assert.equal(called, false);
  assert.equal(model, DEFAULT_VISION_MODEL);
  assert.equal(image, "data:image/png;base64,abc");
  assert.equal(result.food.calories, 720);
  assert.match(result.provider, /llama-3\.2-11b-vision-instruct/);
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

await check("photo route reports an empty model response and blocks zero calories", async () => {
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
  assert.match((await empty.json()).error, /未回傳文字內容/);

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
  assert.match((await zero.json()).error, /0 kcal/);
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
