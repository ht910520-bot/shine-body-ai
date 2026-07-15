import { GoogleGenAI, Type } from "@google/genai";

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: "食物或配菜名稱" },
          calories: { type: Type.INTEGER, description: "估算熱量 (kcal)" },
          protein: { type: Type.NUMBER, description: "估算蛋白質 (g)" },
          carbs: { type: Type.NUMBER, description: "估算碳水化合物 (g)" },
          fat: { type: Type.NUMBER, description: "估算脂肪 (g)" }
        },
        required: ["name", "calories", "protein", "carbs", "fat"]
      }
    },
    totalCalories: { type: Type.INTEGER, description: "總熱量估算 (kcal)" },
    confidence: { type: Type.STRING, description: "置信度，例如 High, Medium, Low" },
    notes: { type: Type.STRING, description: "分析備註或飲食建議" },
    food: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "主餐點名稱，例如：炸雞排便當" },
        calories: { type: Type.INTEGER, description: "總熱量 (kcal)" },
        protein: { type: Type.NUMBER, description: "總蛋白質 (g)" },
        carbs: { type: Type.NUMBER, description: "總碳水 (g)" },
        fat: { type: Type.NUMBER, description: "總脂肪 (g)" },
        description: { type: Type.STRING, description: "整體分析說明" }
      },
      required: ["name", "calories", "protein", "carbs", "fat", "description"]
    }
  },
  required: ["items", "totalCalories", "confidence", "notes", "food"]
};

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "只接受 POST 請求。" });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "伺服器尚未設定 GEMINI_API_KEY。" });
    }

    const { image, mimeType } = req.body || {};
    if (!image || typeof image !== "string") {
      return res.status(400).json({ error: "請提供食物照片。" });
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "shine-body-ai-vercel" } }
    });
    const imagePart = {
      inlineData: { mimeType: mimeType || "image/jpeg", data: image }
    };
    const promptPart = {
      text: "請分析這張食物照片，並估算其中包含的所有食物品項、卡路里（kcal）以及蛋白質、碳水、脂肪（公克）。請以繁體中文撰寫食物名稱與說明。"
    };
    const config = { responseMimeType: "application/json", responseSchema };
    const models = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-3.1-flash-lite"];
    let response: any;
    let usedModel = models[0];
    let lastError: any;

    for (const model of models) {
      try {
        usedModel = model;
        response = await ai.models.generateContent({
          model,
          contents: [imagePart, promptPart],
          config
        });
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!response) throw lastError || new Error("所有 Gemini 模型皆無法使用。");
    const responseText = response.text;
    if (!responseText) throw new Error("Gemini 未回傳任何文字內容。");
    const parsedData = JSON.parse(responseText.trim());

    return res.status(200).json({
      food: parsedData.food,
      provider: `Gemini AI (${usedModel})`,
      items: parsedData.items,
      totalCalories: parsedData.totalCalories,
      confidence: parsedData.confidence,
      notes: parsedData.notes
    });
  } catch (error: any) {
    console.error("AI Analysis error:", error);
    return res.status(500).json({ error: `AI 分析失敗: ${error?.message || error}` });
  }
}
