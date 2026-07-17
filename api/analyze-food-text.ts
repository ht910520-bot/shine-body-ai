import { GoogleGenAI } from "@google/genai";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type Source = {
  title: string;
  url: string;
};

const rateLimit = new Map<string, { count: number; resetAt: number }>();
const MAX_REQUESTS_PER_HOUR = 20;

function getClientIp(req: any) {
  const forwarded = req.headers?.["x-forwarded-for"];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0])?.trim()
    || req.socket?.remoteAddress
    || "unknown";
}

function allowRequest(ip: string) {
  const now = Date.now();
  const current = rateLimit.get(ip);
  if (!current || current.resetAt <= now) {
    rateLimit.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (current.count >= MAX_REQUESTS_PER_HOUR) return false;
  current.count += 1;
  return true;
}

function parseJson(text: string) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("AI 回覆格式不完整");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function collectSources(response: any): Source[] {
  const found = new Map<string, Source>();
  for (const candidate of response?.candidates || []) {
    for (const chunk of candidate?.groundingMetadata?.groundingChunks || []) {
      const web = chunk?.web;
      if (web?.uri && !found.has(web.uri)) {
        found.set(web.uri, { title: web.title || "參考資料", url: web.uri });
      }
    }
  }
  return [...found.values()].slice(0, 5);
}

function isQuotaError(error: any) {
  const message = String(error?.message || error || "").toLowerCase();
  return error?.status === "RESOURCE_EXHAUSTED"
    || error?.code === 429
    || message.includes("quota")
    || message.includes("resource_exhausted")
    || message.includes("rate limit");
}

function fallbackEstimate(message: string) {
  const text = message.toLowerCase();
  if (/飯糰|饭团|御飯糰|御饭团/.test(text)) {
    return {
      name: message,
      calories: 380,
      protein: 10,
      carbs: 55,
      fat: 12,
      description: "Gemini 配額暫時用完，先以一般便利商店飯糰一個估算；實際口味與大小可能不同。"
    };
  }
  if (/雞胸.*便當|便當.*雞胸|鸡胸.*便当|便当.*鸡胸/.test(text)) {
    return {
      name: message,
      calories: 650,
      protein: 40,
      carbs: 75,
      fat: 18,
      description: "Gemini 配額暫時用完，先以雞胸肉、白飯、兩樣配菜的一般便當估算。"
    };
  }
  if (/便當|便当/.test(text)) {
    return {
      name: message,
      calories: 700,
      protein: 30,
      carbs: 85,
      fat: 24,
      description: "Gemini 配額暫時用完，先以一份台式便當的常見份量估算。"
    };
  }
  return null;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "只接受 POST 請求" });
  }

  const ip = getClientIp(req);
  if (!allowRequest(ip)) {
    return res.status(429).json({ error: "查詢次數太頻繁，請稍後再試" });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "伺服器尚未設定 GEMINI_API_KEY" });

    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const history: ChatMessage[] = Array.isArray(req.body?.history)
      ? req.body.history
          .filter((item: any) => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string")
          .slice(-6)
          .map((item: any) => ({ role: item.role, content: item.content.slice(0, 500) }))
      : [];

    if (!message) return res.status(400).json({ error: "請輸入吃了什麼" });
    if (message.length > 500) return res.status(400).json({ error: "內容請控制在 500 字以內" });

    const conversation = [...history, { role: "user", content: message }]
      .map((item) => `${item.role === "user" ? "使用者" : "營養助理"}：${item.content}`)
      .join("\n");

    const prompt = `你是台灣飲食熱量估算助理。請使用 Google Search 查找產品官網、便利商店、餐廳或可信營養資料，協助使用者把自然語言轉成一筆飲食紀錄。

規則：
1. 使用繁體中文。品牌商品（例如 7-ELEVEN 商品）優先採官方或商品標示資料。
2. 若餐點已足夠明確，直接估算。若份量、主食或配菜差異會明顯影響結果，只問一個最重要且簡短的問題。
3. 對話已有兩次使用者訊息，或使用者表示「直接估」，就不要再追問，改用合理常見份量估算並列出假設。
4. 熱量與營養素都代表這次實際吃下的總量；未知的三大營養素可依典型配方合理估算。
5. 僅輸出 JSON，不要 Markdown，不要額外說明。

需要追問時輸出：
{"status":"clarify","question":"一個問題","summary":"目前理解"}

可估算時輸出：
{"status":"ready","food":{"name":"餐點名稱","calories":整數,"protein":數字,"carbs":數字,"fat":數字,"description":"估算依據與份量假設"},"confidence":"high|medium|low","assumptions":["假設一"]}

對話：
${conversation}`;

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "shine-body-ai-vercel" } }
    });
    const models = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"];
    let response: any;
    let usedModel = models[0];
    let lastError: any;
    let quotaExceeded = false;

    for (const model of models) {
      try {
        usedModel = model;
        response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { tools: [{ googleSearch: {} }] } as any
        });
        break;
      } catch (error) {
        lastError = error;
        if (isQuotaError(error)) {
          quotaExceeded = true;
          break;
        }
      }
    }

    if (!response?.text && quotaExceeded) {
      const fallbackFood = fallbackEstimate(message);
      if (fallbackFood) {
        return res.status(200).json({
          status: "ready",
          food: fallbackFood,
          confidence: "low",
          assumptions: ["Gemini API 配額暫時用完，使用內建常見份量估算"],
          sources: [],
          provider: "本機常見份量估算（Gemini 配額暫滿）",
          warning: "目前無法使用網路搜尋，這筆數字是暫時估算；配額恢復後可重新搜尋。"
        });
      }
      return res.status(429).json({
        code: "GEMINI_QUOTA_EXCEEDED",
        error: "Gemini API 配額已用完，暫時無法進行網路搜尋。請稍後再試，或先手動輸入熱量。"
      });
    }

    if (!response?.text) throw lastError || new Error("Gemini 沒有回傳內容");
    const parsed = parseJson(response.text);
    const sources = collectSources(response);

    if (parsed.status === "clarify" && typeof parsed.question === "string") {
      return res.status(200).json({
        status: "clarify",
        question: parsed.question,
        summary: parsed.summary || "",
        sources,
        provider: `Gemini AI (${usedModel})`
      });
    }

    const food = parsed.food;
    if (!food || !food.name || !Number.isFinite(Number(food.calories))) {
      throw new Error("AI 無法產生有效的熱量估算");
    }

    return res.status(200).json({
      status: "ready",
      food: {
        name: String(food.name),
        calories: Math.max(0, Math.round(Number(food.calories))),
        protein: Math.max(0, Math.round((Number(food.protein) || 0) * 10) / 10),
        carbs: Math.max(0, Math.round((Number(food.carbs) || 0) * 10) / 10),
        fat: Math.max(0, Math.round((Number(food.fat) || 0) * 10) / 10),
        description: String(food.description || "依常見份量估算")
      },
      confidence: parsed.confidence || "medium",
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.slice(0, 5) : [],
      sources,
      provider: `Gemini AI + Google Search (${usedModel})`,
      warning: ""
    });
  } catch (error: any) {
    console.error("Text food analysis error:", error);
    return res.status(500).json({ error: `搜尋估算失敗：${error?.message || error}` });
  }
}

