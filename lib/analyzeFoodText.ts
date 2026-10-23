const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
export const MISSING_NVIDIA_KEY_ERROR = "伺服器尚未設定 NVIDIA_API_KEY 或 NVIDIA_DEEPSEEK_API_KEY。";
// meta/llama-3.1-8b-instruct is no longer returned by
// https://integrate.api.nvidia.com/v1/models (checked 2026-10-23). Mistral NeMo
// Minitron 8B is a small non-reasoning instruct model that is still listed.
export const DEFAULT_NVIDIA_TEXT_MODEL = "nvidia/mistral-nemo-minitron-8b-8k-instruct";
export const DEFAULT_NVIDIA_TEXT_TIMEOUT_MS = 12_000;
export const DEFAULT_NVIDIA_TEXT_MAX_TOKENS = 1_200;
const MIN_NVIDIA_TEXT_TIMEOUT_MS = 3_000;
const MAX_NVIDIA_TEXT_TIMEOUT_MS = 25_000;
const MIN_NVIDIA_TEXT_MAX_TOKENS = 256;
const MAX_NVIDIA_TEXT_MAX_TOKENS = 4_096;


function parseJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("NVIDIA 沒有回傳可讀取的 JSON。");
  }
}


function messageText(content: any) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || part?.content || "").join("\n");
  }
  return "";
}


function clampNumber(value: string | undefined, fallback: number, min: number, max: number) {
  const configured = Number(value);
  if (!Number.isFinite(configured)) return fallback;
  return Math.min(Math.max(configured, min), max);
}


export function textRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    model: env.NVIDIA_MODEL || DEFAULT_NVIDIA_TEXT_MODEL,
    timeoutMs: clampNumber(
      env.NVIDIA_TEXT_TIMEOUT_MS,
      DEFAULT_NVIDIA_TEXT_TIMEOUT_MS,
      MIN_NVIDIA_TEXT_TIMEOUT_MS,
      MAX_NVIDIA_TEXT_TIMEOUT_MS
    ),
    maxTokens: Math.round(clampNumber(
      env.NVIDIA_TEXT_MAX_TOKENS,
      DEFAULT_NVIDIA_TEXT_MAX_TOKENS,
      MIN_NVIDIA_TEXT_MAX_TOKENS,
      MAX_NVIDIA_TEXT_MAX_TOKENS
    ))
  };
}


function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}


function isTimeout(error: unknown) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}


export async function analyzeFoodText(
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
  if (!nvidiaApiKey) throw new Error(MISSING_NVIDIA_KEY_ERROR);

  const { model, timeoutMs, maxTokens } = textRuntimeConfig();
  try {
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
        max_tokens: maxTokens,
        stream: false
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`NVIDIA HTTP ${response.status}: ${payload?.error?.message || payload?.detail || "請求失敗"}`);
    }
    const choice = payload?.choices?.[0];
    const finishReason = choice?.finish_reason;
    const content = messageText(choice?.message?.content);
    if (!content || finishReason === "length") {
      console.warn(
        `NVIDIA text model ${model} returned empty or truncated content: finish_reason=${finishReason ?? "unknown"} usage=${JSON.stringify(payload?.usage ?? null)}`
      );
    }
    if (!content) {
      throw new Error(
        finishReason === "length"
          ? `NVIDIA 文字模型 ${model} 未回傳文字內容（finish_reason=length，輸出長度用盡）。`
          : `NVIDIA 文字模型 ${model} 未回傳文字內容（finish_reason=${finishReason || "unknown"}）。`
      );
    }
    let parsed: any;
    try {
      parsed = parseJson(content);
    } catch (error) {
      if (finishReason === "length") {
        throw new Error(`NVIDIA 文字模型 ${model} 回傳被截斷（finish_reason=length）。${errorMessage(error)}`);
      }
      throw error;
    }
    if (!parsed?.food || !parsed?.status) throw new Error("NVIDIA 回傳的飲食資料格式不完整。");
    return {
      ...parsed,
      provider: `NVIDIA API (${model})`,
      sources: [],
      notes: `${parsed.notes || ""}${parsed.notes ? " " : ""}目前使用 NVIDIA 模型估算，未連接即時網路搜尋；送出前請確認份量。`
    };
  } catch (error) {
    const message = errorMessage(error);
    const reported = isTimeout(error)
      ? `NVIDIA 文字模型 ${model} 逾時（${timeoutMs}ms）。`
      : message.startsWith("NVIDIA")
        ? message
        : `NVIDIA 文字模型 ${model} 失敗：${message}`;
    console.warn("NVIDIA food text analysis failed.", reported);
    throw new Error(reported);
  }
}
