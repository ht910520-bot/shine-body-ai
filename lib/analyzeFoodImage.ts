const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
export const MISSING_NVIDIA_KEY_ERROR = "伺服器尚未設定 NVIDIA_API_KEY 或 NVIDIA_DEEPSEEK_API_KEY。";
// Retired nvidia/llama-3.1-nemotron-nano-vl-8b-v1 returns HTTP 410, and
// meta/llama-3.2-11b-vision-instruct regularly exceeds the function limit.
// MiniMax is the measured working vision model; Muse Glimmer and Llama 3.2
// 90B are the fallbacks.
export const DEFAULT_NVIDIA_VISION_MODELS = [
  "minimaxai/minimax-m3.1-flash",
  "meta/muse-glimmer-30b",
  "meta/llama-3.2-90b-vision-instruct"
];
export const DEFAULT_NVIDIA_VISION_TIMEOUT_MS = 45_000;
export const DEFAULT_NVIDIA_VISION_TOTAL_TIMEOUT_MS = 55_000;
// MiniMax-M3.1-Flash spends the budget on reasoning before it writes content.
// max_tokens 700 returned finish_reason=length with empty content; 3000
// finished. reasoning_effort is left unset: NVIDIA documents it inside the
// chat template, a rejected field would fail the only proven request, and the
// measured successful body did not send it.
export const DEFAULT_NVIDIA_VISION_MAX_TOKENS = 3_000;
const MIN_NVIDIA_VISION_TIMEOUT_MS = 1_000;
const MAX_NVIDIA_VISION_TIMEOUT_MS = 50_000;
const MIN_NVIDIA_VISION_TOTAL_TIMEOUT_MS = 10_000;
const MAX_NVIDIA_VISION_TOTAL_TIMEOUT_MS = 55_000;
const MIN_NVIDIA_VISION_MAX_TOKENS = 256;
const MAX_NVIDIA_VISION_MAX_TOKENS = 8_192;


function parseJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    // Vision models sometimes append an explanation after an otherwise valid
    // JSON object. Extract the first balanced object instead of using the last
    // closing brace, which can accidentally include the trailing explanation.
    const start = cleaned.indexOf("{");
    if (start >= 0) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = start; index < cleaned.length; index += 1) {
        const character = cleaned[index];
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (character === "\\") {
            escaped = true;
          } else if (character === '"') {
            inString = false;
          }
          continue;
        }
        if (character === '"') {
          inString = true;
        } else if (character === "{") {
          depth += 1;
        } else if (character === "}") {
          depth -= 1;
          if (depth === 0) return JSON.parse(cleaned.slice(start, index + 1));
        }
      }
    }
    throw new Error("AI 沒有回傳可讀取的 JSON。");
  }
}


function messageText(content: any) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || part?.content || "").join("\n");
  }
  return "";
}


function safeMimeType(mimeType?: string) {
  return /^image\/(jpeg|jpg|png|webp)$/i.test(mimeType || "") ? mimeType : "image/jpeg";
}


function parseModelList(value?: string) {
  return (value || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}


function clampNumber(value: string | undefined, fallback: number, min: number, max: number) {
  const configured = Number(value);
  if (!Number.isFinite(configured)) return fallback;
  return Math.min(Math.max(configured, min), max);
}


export function visionRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const primaryModel = env.NVIDIA_VISION_MODEL || DEFAULT_NVIDIA_VISION_MODELS[0];
  const configuredModels = parseModelList(env.NVIDIA_VISION_MODELS);
  const configuredFallbackModels = [
    ...parseModelList(env.NVIDIA_VISION_FALLBACK_MODELS),
    ...parseModelList(env.NVIDIA_VISION_FALLBACK_MODEL)
  ];
  const models = configuredModels.length
    ? [...new Set(configuredModels)]
    : [...new Set([
      primaryModel,
      ...configuredFallbackModels,
      ...(configuredFallbackModels.length
        ? []
        : DEFAULT_NVIDIA_VISION_MODELS.filter((model) => model !== primaryModel))
    ])];
  return {
    models,
    timeoutMs: clampNumber(
      env.NVIDIA_VISION_TIMEOUT_MS,
      DEFAULT_NVIDIA_VISION_TIMEOUT_MS,
      MIN_NVIDIA_VISION_TIMEOUT_MS,
      MAX_NVIDIA_VISION_TIMEOUT_MS
    ),
    totalTimeoutMs: clampNumber(
      env.NVIDIA_VISION_TOTAL_TIMEOUT_MS,
      DEFAULT_NVIDIA_VISION_TOTAL_TIMEOUT_MS,
      MIN_NVIDIA_VISION_TOTAL_TIMEOUT_MS,
      MAX_NVIDIA_VISION_TOTAL_TIMEOUT_MS
    ),
    maxTokens: Math.round(clampNumber(
      env.NVIDIA_VISION_MAX_TOKENS,
      DEFAULT_NVIDIA_VISION_MAX_TOKENS,
      MIN_NVIDIA_VISION_MAX_TOKENS,
      MAX_NVIDIA_VISION_MAX_TOKENS
    ))
  };
}


// NVIDIA's hosted vision models officially expect English instructions for
// image+text requests. Keep the prompt in English, but ask for Traditional
// Chinese display strings so the result still matches the app UI. Avoid a JSON
// example filled with zeroes because smaller vision models tend to copy them.
const imagePrompt = `Analyze the attached meal photo. Identify every visible food and side dish, then estimate realistic calories, protein, carbohydrates, and fat for the entire visible serving.

Return exactly one valid JSON object without Markdown. It must contain:
- "items": an array of objects with "name", "calories", "protein", "carbs", and "fat".
- "totalCalories": the integer calorie total for all items.
- "confidence": exactly "high", "medium", or "low".
- "notes": a short estimation note.
- "food": an object with "name", "calories", "protein", "carbs", "fat", and "description" for the whole meal.

Use numbers only for all nutrition fields, without units. If any edible food is visible, every applicable calorie estimate and totalCalories must be greater than zero; do not use placeholder zeroes. Use reasonable common serving sizes when exact weight is unknown. Only return zero calories when there is no food or the image cannot be read. Do not claim exact weights or official nutrition facts. Write all human-readable names, notes, and descriptions in Traditional Chinese.`;


function positiveNumber(value: any) {
  const number = typeof value === "string"
    ? Number(value.match(/-?\d+(?:\.\d+)?/)?.[0])
    : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}


function normalizeResult(parsed: any) {
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const itemTotal = items.reduce((sum: number, item: any) => sum + positiveNumber(item?.calories), 0);
  const food = parsed?.food || {};
  const calories = Math.round(positiveNumber(food.calories) || positiveNumber(parsed?.totalCalories) || itemTotal);
  if (calories <= 0) {
    throw new Error("模型沒有辨識出可估算的食物熱量，已阻止寫入 0 kcal。");
  }
  const protein = positiveNumber(food.protein) || items.reduce((sum: number, item: any) => sum + positiveNumber(item?.protein), 0);
  const carbs = positiveNumber(food.carbs) || items.reduce((sum: number, item: any) => sum + positiveNumber(item?.carbs), 0);
  const fat = positiveNumber(food.fat) || items.reduce((sum: number, item: any) => sum + positiveNumber(item?.fat), 0);
  return {
    food: {
      ...food,
      name: food.name || "照片餐點",
      calories,
      protein: Math.round(protein * 10) / 10,
      carbs: Math.round(carbs * 10) / 10,
      fat: Math.round(fat * 10) / 10,
      description: food.description || "依照片可見份量估算"
    },
    items,
    totalCalories: calories,
    confidence: parsed?.confidence || "low",
    notes: parsed?.notes || "請確認照片中的份量與食物品項。"
  };
}


function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}


function isTimeout(error: unknown) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}


function warnOnEmptyOrTruncated(model: string, finishReason: unknown, content: string, usage: unknown) {
  if (content && finishReason !== "length") return;
  console.warn(
    `NVIDIA Vision model ${model} returned empty or truncated content: finish_reason=${finishReason ?? "unknown"} usage=${JSON.stringify(usage ?? null)}`
  );
}


async function analyzeWithNvidia(image: string, mimeType?: string) {
  const apiKey = process.env.NVIDIA_API_KEY || process.env.NVIDIA_DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error(MISSING_NVIDIA_KEY_ERROR);

  const { models, timeoutMs, totalTimeoutMs, maxTokens } = visionRuntimeConfig();
  const startedAt = Date.now();
  let lastError: Error | undefined;
  for (const model of models) {
    const remainingMs = totalTimeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    const requestTimeoutMs = Math.min(timeoutMs, remainingMs);
    try {
      const isQwen = model === "qwen/qwen3.5-397b-a17b";
      const response = await fetch(NVIDIA_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "shine-body-ai-vercel"
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${safeMimeType(mimeType)};base64,${image}` } },
              { type: "text", text: imagePrompt }
            ]
          }],
          temperature: isQwen ? 0.2 : 0.1,
          top_p: isQwen ? 0.8 : 1,
          max_tokens: maxTokens,
          stream: false,
          ...(isQwen ? { chat_template_kwargs: { enable_thinking: false } } : {})
        }),
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
      const payload: any = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`NVIDIA Vision HTTP ${response.status}: ${payload?.error?.message || payload?.detail || "請求失敗"}`);
      }
      const choice = payload?.choices?.[0];
      const finishReason = choice?.finish_reason;
      const content = messageText(choice?.message?.content);
      warnOnEmptyOrTruncated(model, finishReason, content, payload?.usage);
      if (!content) {
        throw new Error(
          finishReason === "length"
            ? `NVIDIA Vision 模型 ${model} 未回傳文字內容（finish_reason=length，輸出長度用盡）。`
            : `NVIDIA Vision 模型 ${model} 未回傳文字內容（finish_reason=${finishReason || "unknown"}）。`
        );
      }
      let parsed: any;
      try {
        parsed = parseJson(content);
      } catch (error) {
        if (finishReason === "length") {
          throw new Error(`NVIDIA Vision 模型 ${model} 回傳被截斷（finish_reason=length）。${errorMessage(error)}`);
        }
        throw error;
      }
      const normalized = normalizeResult(parsed);
      return {
        ...normalized,
        provider: `NVIDIA Vision API (${model})`,
        notes: `${normalized.notes}${normalized.notes ? " " : ""}照片熱量為 NVIDIA 模型估算，送出前請確認份量。`
      };
    } catch (error) {
      const message = errorMessage(error);
      const reported = isTimeout(error)
        ? `NVIDIA Vision 模型 ${model} 逾時（${requestTimeoutMs}ms）。`
        : message.startsWith("NVIDIA")
          ? message
          : `NVIDIA Vision 模型 ${model} 失敗：${message}`;
      lastError = new Error(reported);
      console.warn(`NVIDIA Vision model ${model} failed; trying next model.`, reported);
    }
  }
  throw lastError || new Error("所有 NVIDIA Vision 模型皆無法使用。");
}


export async function analyzeFoodImage(image: string, mimeType?: string) {
  return analyzeWithNvidia(image, mimeType);
}
