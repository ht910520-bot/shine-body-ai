type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type Provider = {
  name: string;
  model: string;
  apiKey?: string;
};

const NVIDIA_ENDPOINT = process.env.NVIDIA_API_BASE_URL || "https://integrate.api.nvidia.com/v1/chat/completions";
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

function isProviderLimitError(error: any) {
  const message = String(error?.message || error || "").toLowerCase();
  return error?.status === 429
    || error?.code === 429
    || message.includes("quota")
    || message.includes("rate limit")
    || message.includes("resource_exhausted");
}

async function callNvidia(provider: Provider, prompt: string) {
  if (!provider.apiKey) throw new Error(`${provider.name} API key 未設定`);
  const response = await fetch(NVIDIA_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 900,
      stream: false
    })
  });

  const payload: any = await response.json().catch(() => null);
  if (!response.ok) {
    const error: any = new Error(payload?.error?.message || `NVIDIA API HTTP ${response.status}`);
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }

  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error(`${provider.name} 沒有回傳內容`);
  return text;
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
      description: "AI 暫時無法連線，先以一般便利商店飯糰一個估算；實際口味與大小可能不同。"
    };
  }
  if (/雞胸.*便當|便當.*雞胸|鸡胸.*便当|便当.*鸡胸/.test(text)) {
    return {
      name: message,
      calories: 650,
      protein: 40,
      carbs: 75,
      fat: 18,
      description: "AI 暫時無法連線，先以雞胸肉、白飯、兩樣配菜的一般便當估算。"
    };
  }
  if (/便當|便当/.test(text)) {
    return {
      name: message,
      calories: 700,
      protein: 30,
      carbs: 85,
      fat: 24,
      description: "AI 暫時無法連線，先以一份台式便當的常見份量估算。"
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
  if (!allowRequest(ip)) return res.status(429).json({ error: "查詢次數太頻繁，請稍後再試" });

  try {
    const providers: Provider[] = [
      {
        name: "NVIDIA DeepSeek",
        model: process.env.NVIDIA_DEEPSEEK_MODEL || "deepseek-ai/deepseek-v4-flash",
        apiKey: process.env.NVIDIA_DEEPSEEK_API_KEY
      },
      {
        name: "NVIDIA Llama",
        model: process.env.NVIDIA_MODEL || "meta/llama-3.3-70b-instruct",
        apiKey: process.env.NVIDIA_API_KEY
      }
    ].filter((provider) => provider.apiKey);

    if (!providers.length) {
      return res.status(500).json({ error: "伺服器尚未設定 NVIDIA_DEEPSEEK_API_KEY 或 NVIDIA_API_KEY" });
    }

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

    const prompt = `你是台灣飲食熱量估算助理。請依你的營養知識，把使用者的自然語言轉成一筆飲食紀錄。

規則：
1. 使用繁體中文。這個服務沒有即時網路搜尋能力，不要捏造網址或引用來源；品牌商品請明確標示為估算。
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

    let responseText = "";
    let usedProvider: Provider | undefined;
    let lastError: any;
    for (const provider of providers) {
      try {
        responseText = await callNvidia(provider, prompt);
        usedProvider = provider;
        break;
      } catch (error) {
        lastError = error;
        // A second NVIDIA key/model can be used as a fallback for quota or transient errors.
        if (!isProviderLimitError(error) && error?.status !== 401 && error?.status !== 403) break;
      }
    }

    if (!responseText) {
      const fallbackFood = fallbackEstimate(message);
      if (fallbackFood && isProviderLimitError(lastError)) {
        return res.status(200).json({
          status: "ready",
          food: fallbackFood,
          confidence: "low",
          assumptions: ["NVIDIA API 暫時無法使用，採內建常見份量估算"],
          sources: [],
          provider: "內建常見份量估算（NVIDIA API 暫時無法使用）",
          warning: "目前無法連線 NVIDIA AI，這筆數字是暫時估算；稍後可重新搜尋。"
        });
      }
      if (lastError?.status === 401 || lastError?.status === 403) {
        return res.status(502).json({ code: "NVIDIA_API_KEY_INVALID", error: "NVIDIA API Key 無效，請檢查 Vercel 的 NVIDIA API 設定" });
      }
      throw lastError || new Error("NVIDIA AI 沒有回傳內容");
    }

    const parsed = parseJson(responseText);
    if (parsed.status === "clarify" && typeof parsed.question === "string") {
      return res.status(200).json({
        status: "clarify",
        question: parsed.question,
        summary: parsed.summary || "",
        sources: [],
        provider: `${usedProvider?.name} (${usedProvider?.model})`
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
      sources: [],
      provider: `${usedProvider?.name} (${usedProvider?.model})`,
      warning: "NVIDIA AI 依模型知識估算，未連接即時網路搜尋；請在新增前確認份量。"
    });
  } catch (error: any) {
    console.error("Text food analysis error:", error);
    return res.status(500).json({ error: `搜尋估算失敗：${error?.message || error}` });
  }
}

