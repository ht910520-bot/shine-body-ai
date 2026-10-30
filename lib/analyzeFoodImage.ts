import {
  MISSING_CLOUDFLARE_CREDS_ERROR,
  parseModelJson,
  runWorkersAi
} from "./cloudflareAi.js";

export { MISSING_CLOUDFLARE_CREDS_ERROR };

// Llama 3.2 11B Vision is the Workers AI photo model. One short call stays
// inside the Vercel Hobby 60s function limit; there is no fallback chain.
export const DEFAULT_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
export const DEFAULT_VISION_TIMEOUT_MS = 50_000;
export const DEFAULT_VISION_MAX_TOKENS = 768;

const imagePrompt = "Identify the meal in the image and estimate calories, protein, carbs, and fat for the whole visible serving. Reply with one JSON object only, no markdown. Include items (name, calories, protein, carbs, fat), totalCalories, confidence (high, medium, or low), notes, and food (name, calories, protein, carbs, fat, description). Use realistic numbers above zero when food is visible. Write names, notes, and description in Traditional Chinese.";


function safeMimeType(mimeType?: string) {
  return /^image\/(jpeg|jpg|png|webp)$/i.test(mimeType || "") ? mimeType : "image/jpeg";
}


export function visionModel(env: NodeJS.ProcessEnv = process.env) {
  return env.CLOUDFLARE_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;
}


function imageInput(image: string, mimeType?: string) {
  const trimmed = image.trim();
  if (/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(trimmed)) return trimmed;
  const raw = trimmed.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
  return `data:${safeMimeType(mimeType)};base64,${raw}`;
}


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


export async function analyzeFoodImage(image: string, mimeType?: string) {
  const model = visionModel();
  try {
    const { text } = await runWorkersAi(model, {
      messages: [{ role: "user", content: imagePrompt }],
      image: imageInput(image, mimeType),
      max_tokens: DEFAULT_VISION_MAX_TOKENS,
      temperature: 0.2
    }, DEFAULT_VISION_TIMEOUT_MS);
    const normalized = normalizeResult(parseModelJson(text));
    return {
      ...normalized,
      provider: `Cloudflare Workers AI (${model})`,
      notes: `${normalized.notes}${normalized.notes ? " " : ""}照片熱量為 Cloudflare Workers AI 估算，送出前請確認份量。`
    };
  } catch (error) {
    const message = errorMessage(error);
    const reported = message.startsWith("Cloudflare") || message.startsWith("模型沒有") || message.startsWith("AI 沒有")
      ? message
      : `Cloudflare Workers AI 模型 ${model} 失敗：${message}`;
    console.warn("Cloudflare Workers AI food photo analysis failed.", reported);
    throw new Error(reported);
  }
}
