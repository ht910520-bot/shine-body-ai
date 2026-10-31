import {
  MISSING_AI_CONFIG_ERROR,
  type AiEnv,
  aiEnvFromProcess,
  runWorkersAi,
  visionRuntimeConfig,
  workersAiJson,
  workersAiText,
  workersAiUsage
} from "./cloudflareAi.js";
import { parseModelJson } from "./modelJson.js";

const imagePrompt = `{
Analyze the attached meal photo. Identify every visible food and side dish, then estimate realistic calories, protein, carbohydrates, and fat for the entire visible serving.

Return exactly one valid JSON object without Markdown. It must contain:
- "items": an array of objects with "name", "calories", "protein", "carbs", and "fat".
- "totalCalories": the integer calorie total for all items.
- "confidence": exactly "high", "medium", or "low".
- "notes": a short estimation note.
- "food": an object with "name", "calories", "protein", "carbs", "fat", and "description" for the whole meal.

Use numbers only for all nutrition fields, without units. If any edible food is visible, every applicable calorie estimate and totalCalories must be greater than zero; do not use placeholder zeroes. Use reasonable common serving sizes when exact weight is unknown. Only return zero calories when there is no food or the image cannot be read. Do not claim exact weights or official nutrition facts. Write all human-readable names, notes, and descriptions in Traditional Chinese. Reply with one JSON object only, no Markdown or preamble.`;

const retryPrompt = `Reply with ONLY one JSON object, no markdown, no preamble, and no bullet lists. Use Traditional Chinese names, notes, and descriptions. Identify visible food and estimate nutrition for the whole serving. Include items, totalCalories, confidence, notes, and food (name, calories, protein, carbs, fat, description). Use numeric nutrition values and positive calories when food is visible.`;

function safeMimeType(mimeType?: string) {
  return /^image\/(jpeg|jpg|png|webp)$/i.test(mimeType || "") ? mimeType : "image/jpeg";
}

function positiveNumber(value: unknown) {
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

export function visionImageInput(image: string, mimeType?: string) {
  const base64 = image.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
  return `data:${safeMimeType(mimeType)};base64,${base64}`;
}

export async function analyzeFoodImage(image: string, mimeType?: string, env: AiEnv = aiEnvFromProcess()) {
  const { model, timeoutMs, maxTokens } = visionRuntimeConfig(env);
  try {
    let payload = await runWorkersAi(model, {
      prompt: imagePrompt,
      image: visionImageInput(image, mimeType),
      max_tokens: maxTokens,
      temperature: 0.1
    }, env, timeoutMs);
    let direct = workersAiJson(payload);
    let content = workersAiText(payload).trim();
    if (!content) {
      console.warn(JSON.stringify({
        event: "workers_ai_empty_response",
        kind: "vision",
        model,
        usage: workersAiUsage(payload)
      }));
      throw new Error(`Cloudflare Vision 模型 ${model} 未回傳文字內容。`);
    }
    let parsed: any;
    try { parsed = direct || parseModelJson(content); }
    catch {
      payload = await runWorkersAi(model, { prompt: retryPrompt, image: visionImageInput(image, mimeType), max_tokens: maxTokens, temperature: 0.1 }, env, timeoutMs);
      direct = workersAiJson(payload);
      content = workersAiText(payload).trim();
      parsed = direct || parseModelJson(content);
    }
    const normalized = normalizeResult(parsed);
    return {
      ...normalized,
      provider: `Cloudflare Workers AI (${model})`,
      notes: `${normalized.notes}${normalized.notes ? " " : ""}照片熱量為 Cloudflare Workers AI 估算，送出前請確認份量。`
    };
  } catch (error) {
    const message = errorMessage(error);
    const reported = message === MISSING_AI_CONFIG_ERROR || message.startsWith("Cloudflare") || message.startsWith("模型沒有") || message.startsWith("AI 沒有") || message.startsWith("不支援的") || message.startsWith("伺服器尚未")
      ? message
      : `Cloudflare Vision 模型 ${model} 失敗：${message}`;
    if (message !== MISSING_AI_CONFIG_ERROR) {
      console.warn(JSON.stringify({ event: "workers_ai_vision_failed", model, message: reported }));
    }
    throw new Error(reported);
  }
}
