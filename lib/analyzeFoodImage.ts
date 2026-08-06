import { GoogleGenAI, Type } from "@google/genai";


export const foodImageResponseSchema = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: "食物或配菜名稱" },
          calories: { type: Type.INTEGER, description: "估算熱量 kcal" },
          protein: { type: Type.NUMBER, description: "估算蛋白質 g" },
          carbs: { type: Type.NUMBER, description: "估算碳水化合物 g" },
          fat: { type: Type.NUMBER, description: "估算脂肪 g" }
        },
        required: ["name", "calories", "protein", "carbs", "fat"]
      }
    },
    totalCalories: { type: Type.INTEGER, description: "總熱量估算 kcal" },
    confidence: { type: Type.STRING, description: "估算信心程度 high、medium 或 low" },
    notes: { type: Type.STRING, description: "分析備註或飲食建議" },
    food: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "主餐點名稱" },
        calories: { type: Type.INTEGER, description: "總熱量 kcal" },
        protein: { type: Type.NUMBER, description: "總蛋白質 g" },
        carbs: { type: Type.NUMBER, description: "總碳水 g" },
        fat: { type: Type.NUMBER, description: "總脂肪 g" },
        description: { type: Type.STRING, description: "整體分析說明與份量假設" }
      },
      required: ["name", "calories", "protein", "carbs", "fat", "description"]
    }
  },
  required: ["items", "totalCalories", "confidence", "notes", "food"]
};


const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
// Keep image analysis predictable on serverless runtimes. The previous list
// retried four providers/models serially, which could exceed Vercel's function
// duration before a response was returned.
const DEFAULT_NVIDIA_VISION_MODEL = "meta/llama-3.2-11b-vision-instruct";
const DEFAULT_NVIDIA_TIMEOUT_MS = 15_000;


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


async function analyzeWithNvidia(image: string, mimeType?: string) {
  const apiKey = process.env.NVIDIA_API_KEY || process.env.NVIDIA_DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("未設定 NVIDIA API key。");


  const primaryModel = process.env.NVIDIA_VISION_MODEL || DEFAULT_NVIDIA_VISION_MODEL;
  const fallbackModel = process.env.NVIDIA_VISION_FALLBACK_MODEL;
  const models = [...new Set([primaryModel, fallbackModel].filter(Boolean))] as string[];
  const configuredTimeout = Number(process.env.NVIDIA_VISION_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.min(Math.max(configuredTimeout, 1_000), 25_000)
    : DEFAULT_NVIDIA_TIMEOUT_MS;
  let lastError: any;
  for (const model of models) {
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
      max_tokens: 700,
      stream: false,
      ...(isQwen ? { chat_template_kwargs: { enable_thinking: false } } : {})
    }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const payload: any = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`NVIDIA Vision HTTP ${response.status}: ${payload?.error?.message || payload?.detail || "請求失敗"}`);
      }
      const content = messageText(payload?.choices?.[0]?.message?.content);
      if (!content) throw new Error("NVIDIA Vision 未回傳文字內容。");
      const parsed = parseJson(content);
      const normalized = normalizeResult(parsed);
      return {
        ...normalized,
        provider: `NVIDIA Vision API (${model})`,
        notes: `${normalized.notes}${normalized.notes ? " " : ""}照片熱量為 NVIDIA 模型估算，送出前請確認份量。`
      };
    } catch (error) {
      lastError = error;
      console.warn(`NVIDIA Vision model ${model} failed; trying next model.`, error);
    }
  }
  throw lastError || new Error("所有 NVIDIA Vision 模型皆無法使用。");
}


async function analyzeWithGemini(ai: GoogleGenAI, image: string, mimeType?: string) {
  const imagePart = { inlineData: { mimeType: safeMimeType(mimeType), data: image } };
  const responseModels = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-3.1-flash-lite"];
  let response: any;
  let usedModel = responseModels[0];
  let lastError: any;
  for (const model of responseModels) {
    try {
      usedModel = model;
      response = await ai.models.generateContent({
        model,
        contents: [{ text: imagePrompt }, imagePart],
        config: { responseMimeType: "application/json", responseSchema: foodImageResponseSchema }
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!response) throw lastError || new Error("所有 Gemini 模型皆無法使用。");
  if (!response.text) throw new Error("Gemini 未回傳任何文字內容。");
  const parsed = parseJson(response.text);
  const normalized = normalizeResult(parsed);
  return {
    ...normalized,
    provider: `Gemini AI (${usedModel})`,
  };
}


export async function analyzeFoodImage(
  ai: GoogleGenAI | null,
  image: string,
  mimeType?: string
) {
  const hasNvidiaKey = Boolean(process.env.NVIDIA_API_KEY || process.env.NVIDIA_DEEPSEEK_API_KEY);
  if (hasNvidiaKey) {
    try {
      return await analyzeWithNvidia(image, mimeType);
    } catch (error) {
      console.warn("NVIDIA Vision analysis failed; trying Gemini fallback:", error);
      if (!ai) throw error;
    }
  }
  if (!ai) throw new Error("伺服器尚未設定 NVIDIA API key 或 GEMINI_API_KEY。");
  return analyzeWithGemini(ai, image, mimeType);
}

