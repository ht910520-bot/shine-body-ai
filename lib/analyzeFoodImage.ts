import {
  MISSING_AI_CONFIG_ERROR,
  type AiEnv,
  aiEnvFromProcess,
  runWorkersAi,
  textRuntimeConfig,
  visionRuntimeConfig,
  workersAiJson,
  workersAiText,
  workersAiUsage
} from "./cloudflareAi.js";
import { parseModelJson } from "./modelJson.js";

const imagePrompt = `請只辨識照片中清楚可見的食物、配菜、飲料及大約份量，使用繁體中文列出。不要估算熱量或任何營養數值，不要輸出 JSON、前言或建議；若看不到食物，請簡短說明。`;
const retryPrompt = `請重新查看照片，只用繁體中文列出清楚可見的食物與大約份量。不要估算熱量或營養，不要輸出 JSON。`;
const nutritionPrompt = (description: string) => `根據以下照片辨識描述，估算整份餐點的營養：\n${description}\n\n請合理估算常見份量，不要假稱精確重量或官方數據。所有文字使用繁體中文。只回傳 JSON，不要 Markdown 或前言，格式如下：{"items":[{"name":"食物名稱","calories":1,"protein":1,"carbs":1,"fat":1}],"totalCalories":1,"confidence":"high|medium|low","notes":"份量假設","food":{"name":"餐點名稱","calories":1,"protein":1,"carbs":1,"fat":1,"description":"餐點與份量描述"}}。看得到食物時所有適用熱量須大於零。`;

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
  const textConfig = textRuntimeConfig(env);
  try {
    let payload = await runWorkersAi(model, {
      prompt: imagePrompt,
      image: visionImageInput(image, mimeType),
      max_tokens: maxTokens,
      temperature: 0.1
    }, env, timeoutMs);
    let content = workersAiText(payload).trim();
    if (!content) {
      console.warn(JSON.stringify({
        event: "workers_ai_empty_response",
        kind: "vision",
        model,
        usage: workersAiUsage(payload)
      }));
      payload = await runWorkersAi(model, { prompt: retryPrompt, image: visionImageInput(image, mimeType), max_tokens: maxTokens, temperature: 0.1 }, env, timeoutMs);
      content = workersAiText(payload).trim();
      if (!content) throw new Error(`Cloudflare Vision 模型 ${model} 未回傳文字內容。`);
    }
    const description = content;
    async function estimateNutrition(prompt: string) {
      const nutritionPayload = await runWorkersAi(textConfig.model, {
        messages: [
          { role: "system", content: "你是嚴謹的繁體中文飲食熱量估算助手。只輸出指定 JSON。可見食物時熱量必須大於 0。" },
          { role: "user", content: prompt }
        ],
        max_tokens: textConfig.maxTokens,
        temperature: 0.1
      }, env, textConfig.timeoutMs);
      const nutritionContent = workersAiText(nutritionPayload).trim();
      return workersAiJson(nutritionPayload) || parseModelJson(nutritionContent);
    }
    let parsed: any = await estimateNutrition(nutritionPrompt(description));
    try {
      normalizeResult(parsed);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("0 kcal")) throw error;
      parsed = await estimateNutrition(
        `上一輪估出 0 熱量，請依描述重新估算且熱量必須 > 0。\n${nutritionPrompt(description)}`
      );
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
