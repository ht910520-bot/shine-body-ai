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
    if (start === -1 || end <= start) throw new Error("AI ???澆?銝???);
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function isProviderLimitError(error: any) {
  const message = String(error?.message || error || "").toLowerCase();
  return error?.status === 429
    || error?.status === 503
    || error?.code === 429
    || message.includes("quota")
    || message.includes("rate limit")
    || message.includes("resource_exhausted")
    || message.includes("resourceexhausted")
    || message.includes("service unavailable");
}

async function callNvidia(provider: Provider, prompt: string) {
  if (!provider.apiKey) throw new Error(`${provider.name} API key ?芾身摰);
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
  if (typeof text !== "string" || !text.trim()) throw new Error(`${provider.name} 瘝???批捆`);
  return text;
}

function fallbackEstimate(message: string) {
  const text = message.toLowerCase();
  if (/憌舐陸|擖剖|敺⊿ㄞ蝟院敺⊿平??.test(text)) {
    return {
      name: message,
      calories: 380,
      protein: 10,
      carbs: 55,
      fat: 12,
      description: "AI ?急??⊥????嚗?隞乩??砌噶?拙?摨ㄞ蝟唬??摯蝞?撖阡????之撠?賭???
    };
  }
  if (/?.*靘輻|靘輻.*?|曏∟.*靘踹?|靘踹?.*曏∟/.test(text)) {
    return {
      name: message,
      calories: 650,
      protein: 40,
      carbs: 75,
      fat: 18,
      description: "AI ?急??⊥????嚗?隞仿??貉??憌胯璅????銝?砌噶?嗡摯蝞?
    };
  }
  if (/靘輻|靘踹?/.test(text)) {
    return {
      name: message,
      calories: 700,
      protein: 30,
      carbs: 85,
      fat: 24,
      description: "AI ?急??⊥????嚗?隞乩?隞賢撘噶?嗥?撣貉?隞賡?隡啁???
    };
  }
  return null;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "?芣??POST 隢?" });
  }

  const ip = getClientIp(req);
  if (!allowRequest(ip)) return res.status(429).json({ error: "?亥岷甈⊥憭芷蝜?隢?敺?閰? });

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
      return res.status(500).json({ error: "隡箸??典??芾身摰?NVIDIA_DEEPSEEK_API_KEY ??NVIDIA_API_KEY" });
    }

    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const history: ChatMessage[] = Array.isArray(req.body?.history)
      ? req.body.history
          .filter((item: any) => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string")
          .slice(-6)
          .map((item: any) => ({ role: item.role, content: item.content.slice(0, 500) }))
      : [];

    if (!message) return res.status(400).json({ error: "隢撓?亙?鈭?暻? });
    if (message.length > 500) return res.status(400).json({ error: "?批捆隢?嗅 500 摮誑?? });

    const conversation = [...history, { role: "user", content: message }]
      .map((item) => `${item.role === "user" ? "雿輻?? : "???拍?"}嚗?{item.content}`)
      .join("\n");

    const prompt = `雿?啁憌脤??梢?隡啁??拍???靘???擗霅??蝙?刻??芰隤?頧?銝蝑ㄡ憌???
閬?嚗?1. 雿輻蝜?銝剜???????雯頝舀?撠??銝??雯????其?皞?????隢?蝣箸?蝷箇隡啁???2. ?仿?暺歇頞喳??Ⅱ嚗?乩摯蝞隞賡??蜓憌???撌桃??憿臬蔣?輻????芸?銝????銝陛?剔?????3. 撠店撌脫??拇活雿輻???荔??蝙?刻”蝷箝?乩摯??撠曹?閬?餈賢?嚗?典??虜閬遢?摯蝞蒂??身??4. ?梢???擗??賭誨銵券活撖阡????蜇???芰??憭抒?擗??臭??詨????隡啁???5. ?撓??JSON嚗?閬?Markdown嚗?閬?憭牧??
?閬蕭??頛詨嚗?{"status":"clarify","question":"銝??憿?,"summary":"?桀??圾"}

?臭摯蝞?頛詨嚗?{"status":"ready","food":{"name":"擗??迂","calories":?湔,"protein":?詨?,"carbs":?詨?,"fat":?詨?,"description":"隡啁?靘??遢??閮?},"confidence":"high|medium|low","assumptions":["?身銝"]}

撠店嚗?${conversation}`;

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
          assumptions: ["NVIDIA API ?急??⊥?雿輻嚗?批遣撣貉?隞賡?隡啁?"],
          sources: [],
          provider: "?批遣撣貉?隞賡?隡啁?嚗VIDIA API ?急??⊥?雿輻嚗?,
          warning: "?桀??⊥???? NVIDIA AI嚗??詨??舀?摯蝞?蝔??舫??唳?撠?
        });
      }
      if (lastError?.status === 401 || lastError?.status === 403) {
        return res.status(502).json({ code: "NVIDIA_API_KEY_INVALID", error: "NVIDIA API Key ?⊥?嚗?瑼Ｘ Vercel ??NVIDIA API 閮剖?" });
      }
      throw lastError || new Error("NVIDIA AI 瘝???批捆");
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
      throw new Error("AI ?⊥??Ｙ?????摯蝞?);
    }

    return res.status(200).json({
      status: "ready",
      food: {
        name: String(food.name),
        calories: Math.max(0, Math.round(Number(food.calories))),
        protein: Math.max(0, Math.round((Number(food.protein) || 0) * 10) / 10),
        carbs: Math.max(0, Math.round((Number(food.carbs) || 0) * 10) / 10),
        fat: Math.max(0, Math.round((Number(food.fat) || 0) * 10) / 10),
        description: String(food.description || "靘虜閬遢?摯蝞?)
      },
      confidence: parsed.confidence || "medium",
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.slice(0, 5) : [],
      sources: [],
      provider: `${usedProvider?.name} (${usedProvider?.model})`,
      warning: "NVIDIA AI 靘芋?霅摯蝞??芷??單?蝬脰楝??嚗??冽憓?蝣箄?隞賡???
    });
  } catch (error: any) {
    console.error("Text food analysis error:", error);
    return res.status(500).json({ error: `??隡啁?憭望?嚗?{error?.message || error}` });
  }
}

