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
const nvidiaModels = [
  "qwen/qwen3.5-397b-a17b",
  "meta/llama-3.2-90b-vision-instruct",
  "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
  "meta/llama-3.2-11b-vision-instruct"
];


function parseJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
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


const imagePrompt = `請分析這張食物照片，辨識所有看得到的食物與配菜，估算整份餐點的總熱量，以及蛋白質、碳水、脂肪（公克）。請使用繁體中文。照片分析只能估算，不能聲稱知道精確重量或官方營養標示。只要照片中看得到食物，就不可以把熱量填 0；請依常見份量給合理估算，只有完全沒有食物或圖片無法讀取時才可填 0。只回傳 JSON，不要 Markdown，格式如下：
{"items":[{"name":"食物名稱","calories":0,"protein":0,"carbs":0,"fat":0}],"totalCalories":0,"confidence":"medium","notes":"估算備註","food":{"name":"主餐點名稱","calories":0,"protein":0,"carbs":0,"fat":0,"description":"份量假設與分析說明"}}`;


function positiveNumber(value: any) {
  const number = Number(value);
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


  const models = process.env.NVIDIA_VISION_MODEL ? [process.env.NVIDIA_VISION_MODEL] : nvidiaModels;
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
          { type: "text", text: imagePrompt },
          { type: "image_url", image_url: { url: `data:${safeMimeType(mimeType)};base64,${image}` } }
        ]
      }],
      temperature: isQwen ? 0.2 : 0.1,
      top_p: isQwen ? 0.8 : 1,
      max_tokens: 1400,
      stream: false,
      ...(isQwen ? { chat_template_kwargs: { enable_thinking: false } } : {})
    })
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

