import { GoogleGenAI, Type } from "@google/genai";


export const foodTextResponseSchema = {
  type: Type.OBJECT,
  properties: {
    status: {
      type: Type.STRING,
      enum: ["complete", "needs_confirmation"],
      description: "資料足夠時為 complete；影響熱量判斷的重要資訊不足時為 needs_confirmation"
    },
    question: {
      type: Type.STRING,
      description: "需要使用者補充時，只問一個最重要的繁體中文問題；不需要時留空"
    },
    food: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "餐點名稱" },
        calories: { type: Type.INTEGER, description: "整份或該餐點的估算熱量 kcal" },
        protein: { type: Type.NUMBER, description: "蛋白質 g" },
        carbs: { type: Type.NUMBER, description: "碳水化合物 g" },
        fat: { type: Type.NUMBER, description: "脂肪 g" },
        description: { type: Type.STRING, description: "估算依據、份量假設與注意事項" }
      },
      required: ["name", "calories", "protein", "carbs", "fat", "description"]
    },
    confidence: {
      type: Type.STRING,
      enum: ["high", "medium", "low"],
      description: "估算信心程度"
    },
    notes: {
      type: Type.STRING,
      description: "給使用者看的簡短說明"
    }
  },
  required: ["status", "question", "food", "confidence", "notes"]
};


const models = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"];
const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";


function parseJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("Gemini 沒有回傳可讀取的 JSON。");
  }
}


function extractSources(response: any) {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seen = new Set<string>();
  return chunks
    .map((chunk: any) => chunk?.web)
    .filter((web: any) => web?.uri && /^https?:\/\//i.test(web.uri))
    .filter((web: any) => {
      if (seen.has(web.uri)) return false;
      seen.add(web.uri);
      return true;
    })
    .slice(0, 5)
    .map((web: any) => ({ title: web.title || web.uri, url: web.uri }));
}


export async function analyzeFoodText(
  ai: GoogleGenAI | null,
  text: string,
  followUpAnswer?: string,
  previous?: any
) {
  const context = previous
    ? `\n上一次的暫存估算如下，請根據使用者補充重新判斷：${JSON.stringify(previous)}`
    : "";
  const answer = followUpAnswer?.trim()
    ? `\n使用者對上一個問題的回答：「${followUpAnswer.trim()}」`
    : "";
  const prompt = `你是「閃耀體態」的飲食熱量查詢助理，請分析使用者輸入的餐點。\n使用者輸入：「${text.trim()}」${answer}${context}\n\n規則：\n1. NVIDIA API 在這個流程沒有即時網路搜尋；只能依模型既有知識與常見台灣餐點份量估算。嚴禁聲稱「已搜尋網路」、「官方營養標示」或捏造網址。\n2. 找不到完全相同資料時，可以用相近份量估算，但要在 description/notes 說明假設，不能假裝是精確值。\n3. 「雞胸肉便當」這類名稱若還缺少會大幅影響熱量的資訊（例如飯量、是否有炸物、醬汁或份量），回傳 needs_confirmation，question 只問一個最重要、容易回答的問題。\n4. 資訊足夠時回傳 complete；不要為了小誤差反覆追問。\n5. 所有文字使用繁體中文；calories、protein、carbs、fat 都是整份餐點的數值，不要除以分食人數。\n6. 只能回傳符合指定格式的 JSON 物件，不要 Markdown、不要前後解釋。\n\nJSON 格式：\n{"status":"complete 或 needs_confirmation","question":"需要補充時的一個問題，否則空字串","food":{"name":"餐點名稱","calories":0,"protein":0,"carbs":0,"fat":0,"description":"模型估算依據與份量假設"},"confidence":"high、medium 或 low","notes":"簡短說明"}`;


  const nvidiaApiKey = process.env.NVIDIA_API_KEY || process.env.NVIDIA_DEEPSEEK_API_KEY;
  if (nvidiaApiKey) {
    try {
      const model = process.env.NVIDIA_MODEL || (
        process.env.NVIDIA_API_KEY ? "meta/llama-3.1-70b-instruct" : "deepseek-ai/deepseek-v4-flash"
      );
      const response = await fetch(NVIDIA_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${nvidiaApiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "shine-body-ai-vercel"
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: "你是嚴謹的繁體中文飲食熱量估算助手。只輸出使用者指定 JSON schema 對應的欄位。"
            },
            { role: "user", content: prompt }
          ],
          temperature: 0.1,
          max_tokens: 1200,
          stream: false
        })
      });
      const payload: any = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`NVIDIA HTTP ${response.status}: ${payload?.error?.message || payload?.detail || "請求失敗"}`);
      }
      const content = payload?.choices?.[0]?.message?.content;
      if (!content || typeof content !== "string") throw new Error("NVIDIA 未回傳文字內容。");
      const parsed = parseJson(content);
      if (!parsed?.food || !parsed?.status) throw new Error("NVIDIA 回傳的飲食資料格式不完整。");
      return {
        ...parsed,
        provider: `NVIDIA API (${model})`,
        sources: [],
        notes: `${parsed.notes || ""}${parsed.notes ? " " : ""}目前使用 NVIDIA 模型估算，未連接即時網路搜尋；送出前請確認份量。`
      };
    } catch (nvidiaError) {
      console.warn("NVIDIA food text analysis failed; trying Gemini fallback:", nvidiaError);
      if (!ai) throw nvidiaError;
    }
  }


  if (!ai) throw new Error("伺服器尚未設定 NVIDIA_API_KEY 或 GEMINI_API_KEY。");


  let response: any;
  let lastError: any;
  let usedModel = models[0];
  for (const model of models) {
    try {
      usedModel = model;
      response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          responseMimeType: "application/json",
          responseSchema: foodTextResponseSchema
        }
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }


  if (!response) throw lastError || new Error("所有 Gemini 模型皆無法使用。");
  const responseText = response.text;
  if (!responseText) throw new Error("Gemini 未回傳任何文字內容。");
  const parsed = parseJson(responseText);
  if (!parsed?.food || !parsed?.status) throw new Error("Gemini 回傳的飲食資料格式不完整。");


  return {
    ...parsed,
    provider: `Gemini 網路搜尋 (${usedModel})`,
    sources: extractSources(response)
  };
}

