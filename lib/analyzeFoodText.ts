import {
  MISSING_AI_CONFIG_ERROR,
  type AiEnv,
  aiEnvFromProcess,
  runWorkersAi,
  textRuntimeConfig,
  workersAiText,
  workersAiUsage
} from "./cloudflareAi.js";
import { parseModelJson } from "./modelJson.js";

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export async function analyzeFoodText(
  text: string,
  followUpAnswer?: string,
  previous?: unknown,
  env: AiEnv = aiEnvFromProcess()
) {
  const context = previous
    ? `\n上一次的暫存估算如下，請根據使用者補充重新判斷：${JSON.stringify(previous)}`
    : "";
  const answer = followUpAnswer?.trim()
    ? `\n使用者對上一個問題的回答：「${followUpAnswer.trim()}」`
    : "";
  const prompt = `你是「閃耀體態」的飲食熱量查詢助理，請分析使用者輸入的餐點。\n使用者輸入：「${text.trim()}」${answer}${context}\n\n規則：\n1. Workers AI 在這個流程沒有即時網路搜尋；只能依模型既有知識與常見台灣餐點份量估算。嚴禁聲稱「已搜尋網路」、「官方營養標示」或捏造網址。\n2. 找不到完全相同資料時，可以用相近份量估算，但要在 description/notes 說明假設，不能假裝是精確值。\n3. 「雞胸肉便當」這類名稱若還缺少會大幅影響熱量的資訊（例如飯量、是否有炸物、醬汁或份量），回傳 needs_confirmation，question 只問一個最重要、容易回答的問題。\n4. 資訊足夠時回傳 complete；不要為了小誤差反覆追問。\n5. 所有文字使用繁體中文；calories、protein、carbs、fat 都是整份餐點的數值，不要除以分食人數。\n6. 只能回傳符合指定格式的 JSON 物件，不要 Markdown、不要前後解釋。\n\nJSON 格式：\n{"status":"complete 或 needs_confirmation","question":"需要補充時的一個問題，否則空字串","food":{"name":"餐點名稱","calories":0,"protein":0,"carbs":0,"fat":0,"description":"模型估算依據與份量假設"},"confidence":"high、medium 或 low","notes":"簡短說明"}`;

  const { model, timeoutMs, maxTokens } = textRuntimeConfig(env);
  try {
    const payload = await runWorkersAi(model, {
      messages: [
        {
          role: "system",
          content: "你是嚴謹的繁體中文飲食熱量估算助手。只輸出使用者指定 JSON schema 對應的欄位。"
        },
        { role: "user", content: prompt }
      ],
      max_tokens: maxTokens,
      temperature: 0.1
    }, env, timeoutMs);
    const content = workersAiText(payload).trim();
    if (!content) {
      console.warn(JSON.stringify({
        event: "workers_ai_empty_response",
        kind: "text",
        model,
        usage: workersAiUsage(payload)
      }));
      throw new Error(`Cloudflare 文字模型 ${model} 未回傳文字內容。`);
    }
    const parsed = parseModelJson(content);
    if (!parsed?.food || !parsed?.status) throw new Error("Cloudflare 回傳的飲食資料格式不完整。");
    return {
      ...parsed,
      provider: `Cloudflare Workers AI (${model})`,
      sources: [],
      notes: `${parsed.notes || ""}${parsed.notes ? " " : ""}目前使用 Cloudflare Workers AI 估算，未連接即時網路搜尋；送出前請確認份量。`
    };
  } catch (error) {
    const message = errorMessage(error);
    const reported = message === MISSING_AI_CONFIG_ERROR || message.startsWith("Cloudflare") || message.startsWith("AI 沒有") || message.startsWith("不支援的") || message.startsWith("伺服器尚未")
      ? message
      : `Cloudflare 文字模型 ${model} 失敗：${message}`;
    if (message !== MISSING_AI_CONFIG_ERROR) {
      console.warn(JSON.stringify({ event: "workers_ai_text_failed", model, message: reported }));
    }
    throw new Error(reported);
  }
}
