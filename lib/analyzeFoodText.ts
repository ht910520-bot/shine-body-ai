import {
  MISSING_CLOUDFLARE_CREDS_ERROR,
  parseModelJson,
  runWorkersAi
} from "./cloudflareAi.js";

export { MISSING_CLOUDFLARE_CREDS_ERROR };

// llama-3.1-8b-instruct is deprecated on Workers AI. The fast variant is listed
// and stays inside the 30s text function.
export const DEFAULT_TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
export const DEFAULT_TEXT_TIMEOUT_MS = 20_000;
export const DEFAULT_TEXT_MAX_TOKENS = 512;


export function textModel(env: NodeJS.ProcessEnv = process.env) {
  return env.CLOUDFLARE_TEXT_MODEL?.trim() || DEFAULT_TEXT_MODEL;
}


function buildPrompt(text: string, followUpAnswer?: string, previous?: any) {
  const lines = [`餐點：「${text.trim()}」`];
  if (followUpAnswer?.trim()) lines.push(`補充：「${followUpAnswer.trim()}」`);
  if (previous) lines.push(`上次估算：${JSON.stringify(previous)}`);
  return `估算這份餐的熱量。沒有網路搜尋，用常見台灣份量並在 description 寫明假設。若飯量、是否油炸、醬汁或份量會大幅改變熱量，status 用 needs_confirmation，question 只問一個問題；否則 status 用 complete。數字是整份。繁體中文。只回 JSON，欄位：status、question、food.name、food.calories、food.protein、food.carbs、food.fat、food.description、confidence（high、medium 或 low）、notes。\n${lines.join("\n")}`;
}


function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}


export async function analyzeFoodText(
  text: string,
  followUpAnswer?: string,
  previous?: any
) {
  const model = textModel();
  try {
    const { text: content } = await runWorkersAi(model, {
      messages: [
        { role: "system", content: "你是繁體中文飲食熱量估算助手。只輸出 JSON。" },
        { role: "user", content: buildPrompt(text, followUpAnswer, previous) }
      ],
      max_tokens: DEFAULT_TEXT_MAX_TOKENS,
      temperature: 0.2,
      response_format: { type: "json_object" }
    }, DEFAULT_TEXT_TIMEOUT_MS);
    const parsed = parseModelJson(content);
    if (!parsed?.food || !parsed?.status) throw new Error("AI 回傳的飲食資料格式不完整。");
    return {
      ...parsed,
      provider: `Cloudflare Workers AI (${model})`,
      sources: [],
      notes: `${parsed.notes || ""}${parsed.notes ? " " : ""}目前使用 Cloudflare Workers AI 估算，未連接即時網路搜尋；送出前請確認份量。`
    };
  } catch (error) {
    const message = errorMessage(error);
    const reported = message.startsWith("Cloudflare") || message.startsWith("AI ")
      ? message
      : `Cloudflare Workers AI 模型 ${model} 失敗：${message}`;
    console.warn("Cloudflare Workers AI food text analysis failed.", reported);
    throw new Error(reported);
  }
}
