const WORKERS_AI_ORIGIN = "https://api.cloudflare.com/client/v4/accounts";

export const MISSING_CLOUDFLARE_CREDS_ERROR =
  "伺服器尚未設定 CLOUDFLARE_ACCOUNT_ID 與 CLOUDFLARE_API_TOKEN。";

function firstNonEmpty(...values: Array<string | undefined>) {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}


export function cloudflareCredentials(env: NodeJS.ProcessEnv = process.env) {
  return {
    accountId: firstNonEmpty(env.CLOUDFLARE_ACCOUNT_ID, env.CF_ACCOUNT_ID),
    apiToken: firstNonEmpty(env.CLOUDFLARE_API_TOKEN, env.CF_API_TOKEN, env.CLOUDFLARE_AUTH_TOKEN)
  };
}


export function hasCloudflareCredentials(env: NodeJS.ProcessEnv = process.env) {
  const { accountId, apiToken } = cloudflareCredentials(env);
  return Boolean(accountId && apiToken);
}


export function workersAiRunUrl(accountId: string, model: string) {
  return `${WORKERS_AI_ORIGIN}/${encodeURIComponent(accountId)}/ai/run/${model}`;
}


function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}


export function isTimeout(error: unknown) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}


function workersAiErrorMessage(payload: any) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const fromErrors = errors.map((item: any) => item?.message).filter(Boolean).join("; ");
  return fromErrors || payload?.error?.message || payload?.detail || "請求失敗";
}


function messageText(content: any) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || part?.content || "").join("\n");
  }
  return "";
}


export function workersAiText(payload: any) {
  const result = payload?.result ?? payload;
  if (typeof result === "string") return result;
  if (typeof result?.response === "string") return result.response;
  if (typeof result?.description === "string") return result.description;
  const choice = result?.choices?.[0] || payload?.choices?.[0];
  return messageText(choice?.message?.content);
}


export function parseModelJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    if (start >= 0) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = start; index < cleaned.length; index += 1) {
        const character = cleaned[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') inString = true;
        else if (character === "{") depth += 1;
        else if (character === "}") {
          depth -= 1;
          if (depth === 0) return JSON.parse(cleaned.slice(start, index + 1));
        }
      }
    }
    throw new Error("AI 沒有回傳可讀取的 JSON。");
  }
}


export async function runWorkersAi(
  model: string,
  input: Record<string, unknown>,
  timeoutMs: number
) {
  const { accountId, apiToken } = cloudflareCredentials();
  if (!accountId || !apiToken) throw new Error(MISSING_CLOUDFLARE_CREDS_ERROR);

  let response: Response;
  try {
    response = await fetch(workersAiRunUrl(accountId, model), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (isTimeout(error)) {
      throw new Error(`Cloudflare Workers AI 模型 ${model} 逾時（${timeoutMs}ms）。`);
    }
    const message = errorMessage(error);
    throw new Error(
      message.startsWith("Cloudflare")
        ? message
        : `Cloudflare Workers AI 模型 ${model} 失敗：${message}`
    );
  }

  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    throw new Error(
      `Cloudflare Workers AI HTTP ${response.status}: ${workersAiErrorMessage(payload)}`
    );
  }

  const text = workersAiText(payload);
  if (!text.trim()) {
    console.warn(
      `Cloudflare Workers AI model ${model} returned empty content: usage=${JSON.stringify(payload?.result?.usage ?? payload?.usage ?? null)}`
    );
    throw new Error(`Cloudflare Workers AI 模型 ${model} 未回傳文字內容。`);
  }
  return { text, payload };
}
