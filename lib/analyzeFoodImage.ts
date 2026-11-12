import {
  DEFAULT_VISION_BUDGET_MS,
  MISSING_AI_CONFIG_ERROR,
  type AiEnv,
  aiEnvFromProcess,
  hasWorkersAi,
  runWorkersAi,
  visionRuntimeConfig,
  workersAiJson,
  workersAiText
} from "./cloudflareAi.js";
import { parseModelJson } from "./modelJson.js";

export const VISION_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          portion: { type: "string" },
          grams: { type: "number" },
          calories: { type: "number" },
          protein: { type: "number" },
          carbs: { type: "number" },
          fat: { type: "number" }
        },
        required: ["name", "portion", "grams", "calories", "protein", "carbs", "fat"]
      }
    },
    totalCalories: { type: "number" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    notes: { type: "string" },
    food: {
      type: "object",
      properties: {
        name: { type: "string" },
        calories: { type: "number" },
        protein: { type: "number" },
        carbs: { type: "number" },
        fat: { type: "number" },
        description: { type: "string" }
      },
      required: ["name", "calories", "protein", "carbs", "fat", "description"]
    }
  },
  required: ["items", "totalCalories", "confidence", "notes", "food"]
} as const;

export const VISION_SYSTEM_PROMPT =
  "你是專業的台灣繁體中文飲食營養與熱量視覺分析師。請仔細觀察照片中的餐點，只輸出一個符合指定結構的 JSON 物件，不要輸出 Markdown 程式碼區塊或任何額外說明。";

export const VISION_USER_PROMPT = `請分析這張照片中的餐點並估算營養與熱量，嚴格遵守以下規則：
1. 逐項拆開列出每個獨立的可食用品項（items）：不同盤子、不同容器或不同種類的主食、配菜、湯品、甜點必須分開列為個別品項，絕對不可把多種食物合併成同一個品項。
2. 忽略白開水、水杯、餐具、盤子、收據/帳單、紙巾、包裝袋與背景雜物；只列出照片中清楚可見的食物，不可憑空猜測或捏造看不見的品項。
3. 品項名稱先用台灣最常見的菜名（例如炒飯、拉麵、義大利麵、披薩、沙拉、三明治），再具體寫出料理型態、醬料基底（如白醬、紅醬、青醬、清炒、滷汁）與表面可見配料（如四種起司、山羊起司、乳酪種類、肉類、海鮮、蔬菜、堅果等細節）。
4. 仔細區分「派 / 塔 / 法式鹹派(quiche) / 法式布丁塔(flan)」與「起司蛋糕 / 海綿蛋糕 / 麵包 / 餅乾」：若外緣或底部有派皮/塔皮（pastry crust edge），且內餡為凝乳、卡士達或蛋奶餡（custard/egg filling），應辨識為派、塔、法式鹹派（quiche）或法式布丁塔（flan），不可誤判為蛋糕、麵包或餅乾。
5. 先針對每個品項估算照片中的可見份量文字（portion，例如「一碗」、「半份」、「一片」）與預估重量（grams，公克），再估算該品項的熱量（calories，kcal）、蛋白質（protein，g）、碳水化合物（carbs，g）、脂肪（fat，g）。
6. totalCalories 以及 food 內的 calories、protein、carbs、fat 必須等於所有 items 的數值加總；看得到食物時熱量必須大於 0。
7. 所有名稱、份量、notes 與 description 一律使用台灣常用的繁體中文。

請只回傳一個 JSON 物件，格式如下：
{"items":[{"name":"品項名稱","portion":"一碗/半份/一片","grams":100,"calories":200,"protein":10,"carbs":20,"fat":8}],"totalCalories":200,"confidence":"high|medium|low","notes":"估算假設與份量說明","food":{"name":"整份餐點名稱","calories":200,"protein":10,"carbs":20,"fat":8,"description":"各品項與份量摘要"}}`;

export const VISION_RETRY_REMINDER =
  "只回傳一個 JSON 物件，不要 Markdown、不要說明文字；看得到食物時熱量必須 > 0";

function safeMimeType(mimeType?: string) {
  return /^image\/(jpeg|jpg|png|webp)$/i.test(mimeType || "") ? mimeType : "image/jpeg";
}

function positiveNumber(value: unknown) {
  const number = typeof value === "string"
    ? Number(value.match(/-?\d+(?:\.\d+)?/)?.[0])
    : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isZeroCalorieWater(item: any) {
  if (!item || typeof item !== "object") return false;
  if (positiveNumber(item.calories) > 0) return false;
  const name = String(item.name || "").trim();
  if (!name) return true;
  return /^(?:一杯|一壺|一瓶|半杯|杯裝|瓶裝)?(?:冰|溫|熱|涼|常溫|純|白)*(?:開水|礦泉水|氣泡水|純水|飲用水|水杯|水)$/i.test(name)
    || /^(?:a\s+)?(?:glass|cup|bottle|mug)?(?:\s+of)?\s*(?:plain|drinking|sparkling|mineral|ice|cold|warm|hot|tap)*\s*water$/i.test(name);
}

function formatItemWithPortion(item: any): string {
  const name = String(item.name || "").trim() || "食物品項";
  const portion = typeof item.portion === "string" ? item.portion.trim() : "";
  const grams = Math.round(positiveNumber(item.grams));
  if (portion && grams > 0) {
    if (portion.includes(`${grams}`)) return `${name}（${portion}）`;
    return `${name}（${portion}，約 ${grams}g）`;
  }
  if (portion) return `${name}（${portion}）`;
  if (grams > 0) return `${name}（約 ${grams}g）`;
  return name;
}

export function normalizeResult(parsed: any) {
  const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
  const items = rawItems
    .filter((item: any) => item && typeof item === "object" && !isZeroCalorieWater(item))
    .map((item: any) => {
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const portion = typeof item.portion === "string" ? item.portion.trim() : "";
      const grams = Math.round(positiveNumber(item.grams));
      return {
        ...item,
        name: name || "食物品項",
        ...(portion ? { portion } : {}),
        ...(grams > 0 ? { grams } : {}),
        calories: Math.round(positiveNumber(item.calories)),
        protein: Math.round(positiveNumber(item.protein) * 10) / 10,
        carbs: Math.round(positiveNumber(item.carbs) * 10) / 10,
        fat: Math.round(positiveNumber(item.fat) * 10) / 10
      };
    });

  const itemCaloriesSum = items.reduce((sum: number, item: any) => sum + positiveNumber(item.calories), 0);
  const itemProteinSum = items.reduce((sum: number, item: any) => sum + positiveNumber(item.protein), 0);
  const itemCarbsSum = items.reduce((sum: number, item: any) => sum + positiveNumber(item.carbs), 0);
  const itemFatSum = items.reduce((sum: number, item: any) => sum + positiveNumber(item.fat), 0);

  const food = parsed?.food && typeof parsed.food === "object" ? parsed.food : {};
  const hasPositiveItems = itemCaloriesSum > 0;

  const calories = Math.round(
    hasPositiveItems
      ? itemCaloriesSum
      : (positiveNumber(food.calories) || positiveNumber(parsed?.totalCalories))
  );
  if (calories <= 0) {
    throw new Error("模型沒有辨識出可估算的食物熱量，已阻止寫入 0 kcal。");
  }

  const protein = (hasPositiveItems && itemProteinSum > 0)
    ? itemProteinSum
    : (positiveNumber(food.protein) || itemProteinSum);
  const carbs = (hasPositiveItems && itemCarbsSum > 0)
    ? itemCarbsSum
    : (positiveNumber(food.carbs) || itemCarbsSum);
  const fat = (hasPositiveItems && itemFatSum > 0)
    ? itemFatSum
    : (positiveNumber(food.fat) || itemFatSum);

  const itemNames = items.map((item: any) => String(item.name || "").trim()).filter(Boolean);
  const rawFoodName = typeof food.name === "string" ? food.name.trim() : "";
  const isGenericFoodName = !rawFoodName
    || /^(?:照片餐點|餐點名稱|整份餐點名稱|餐點|食物|美食|料理|套餐|早午餐|早餐|午餐|晚餐|點心|宵夜|未知|未知餐點|meal|food|dish)$/i.test(rawFoodName)
    || (itemNames.length > 1 && rawFoodName === itemNames[0]);
  const resolvedFoodName = (!isGenericFoodName ? rawFoodName : itemNames.join("、")) || "照片餐點";

  const rawDescription = typeof food.description === "string" ? food.description.trim() : "";
  const hasPortionDetails = items.some((item: any) => Boolean(item.portion || item.grams));
  const isGenericDescription = !rawDescription
    || /^(?:依照片可見份量估算|餐點與份量描述|各品項與份量摘要)$/.test(rawDescription);
  const itemsPortionSummary = items.map(formatItemWithPortion).join("、");
  const resolvedDescription = (items.length > 0 && (hasPortionDetails || isGenericDescription))
    ? itemsPortionSummary
    : (rawDescription || itemsPortionSummary || "依照片可見份量估算");

  return {
    food: {
      ...food,
      name: resolvedFoodName,
      calories,
      protein: Math.round(protein * 10) / 10,
      carbs: Math.round(carbs * 10) / 10,
      fat: Math.round(fat * 10) / 10,
      description: resolvedDescription
    },
    items,
    totalCalories: calories,
    confidence: parsed?.confidence || "low",
    notes: parsed?.notes || "請確認照片中的份量與食物品項。"
  };
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function visionImageInput(image: string, mimeType?: string) {
  const base64 = image.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
  return `data:${safeMimeType(mimeType)};base64,${base64}`;
}

export function isLegacyVisionModel(model: string) {
  return /llama-3\.2-.*vision/i.test(model);
}

export function isGemmaModel(model: string) {
  return /\/gemma/i.test(model);
}

function isResponseFormatRejected(message: string) {
  return /response_format|json_schema|guided_json|unsupported/i.test(message);
}

function shortModelName(model: string) {
  return model.replace(/^@cf\/[^/]+\//, "");
}

function conciseModelError(model: string, message: string) {
  return message
    .replace(new RegExp(`^Cloudflare Workers AI 模型 ${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `), "")
    .replace(/^Cloudflare Workers AI /, "")
    .replace(/[。.\s]+$/u, "");
}

export function buildVisionModelInput(
  model: string,
  dataUrl: string,
  maxTokens: number,
  options: { retry?: boolean; useResponseFormat?: boolean } = {}
): Record<string, unknown> {
  const userPrompt = options.retry
    ? `${VISION_USER_PROMPT}\n\n${VISION_RETRY_REMINDER}`
    : VISION_USER_PROMPT;

  if (isLegacyVisionModel(model)) {
    return {
      prompt: `${VISION_SYSTEM_PROMPT}\n\n${userPrompt}`,
      image: dataUrl,
      max_tokens: maxTokens,
      temperature: 0.1
    };
  }

  const input: Record<string, unknown> = {
    messages: [
      { role: "system", content: VISION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ],
    max_tokens: maxTokens,
    temperature: 0.1
  };

  if (options.useResponseFormat !== false) {
    input.response_format = {
      type: "json_schema",
      json_schema: VISION_RESPONSE_JSON_SCHEMA
    };
  }

  if (isGemmaModel(model)) {
    input.chat_template_kwargs = { enable_thinking: false };
  }

  return input;
}

function logFailedAttempt(model: string, attempt: number, reason: string, sample: string) {
  console.warn(JSON.stringify({
    event: "workers_ai_vision_attempt_failed",
    model,
    attempt,
    reason,
    sample: sample.slice(0, 300)
  }));
}

export async function analyzeFoodImage(image: string, mimeType?: string, env: AiEnv = aiEnvFromProcess()) {
  const { models, timeoutMs, maxTokens } = visionRuntimeConfig(env);
  if (!hasWorkersAi(env)) throw new Error(MISSING_AI_CONFIG_ERROR);

  const dataUrl = visionImageInput(image, mimeType);
  const startedAt = Date.now();
  const modelFailures: Array<{ model: string; reason: string }> = [];
  let attemptsRun = 0;

  for (const model of models) {
    let useResponseFormat = !isLegacyVisionModel(model);
    let lastModelReason = "";

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const elapsed = Date.now() - startedAt;
      const remainingBudget = DEFAULT_VISION_BUDGET_MS - elapsed;
      if (attemptsRun > 0 && remainingBudget < 1_000) {
        if (!lastModelReason) {
          lastModelReason = "整體分析時間已達上限";
        }
        break;
      }

      const attemptTimeoutMs = attemptsRun === 0
        ? timeoutMs
        : Math.min(timeoutMs, Math.max(1_000, remainingBudget));
      attemptsRun += 1;

      let payload: unknown;
      try {
        const input = buildVisionModelInput(model, dataUrl, maxTokens, {
          retry: attempt > 1,
          useResponseFormat
        });
        try {
          payload = await runWorkersAi(model, input, env, attemptTimeoutMs);
        } catch (innerError) {
          const innerMsg = errorMessage(innerError);
          if (useResponseFormat && isResponseFormatRejected(innerMsg)) {
            useResponseFormat = false;
            const fallbackInput = buildVisionModelInput(model, dataUrl, maxTokens, {
              retry: attempt > 1,
              useResponseFormat: false
            });
            payload = await runWorkersAi(model, fallbackInput, env, attemptTimeoutMs);
          } else {
            throw innerError;
          }
        }
      } catch (error) {
        const msg = errorMessage(error);
        if (msg === MISSING_AI_CONFIG_ERROR || msg.startsWith("不支援的")) {
          throw error;
        }
        const reason = conciseModelError(model, msg);
        logFailedAttempt(model, attempt, reason, "");
        lastModelReason = reason;
        break;
      }

      const direct = workersAiJson(payload);
      const content = workersAiText(payload).trim();

      if (!direct && !content) {
        const reason = "JSON 無法解析（未回傳文字內容）";
        logFailedAttempt(model, attempt, reason, "");
        lastModelReason = reason;
        continue;
      }

      let parsed: any;
      try {
        parsed = direct ? parseModelJson(direct) : parseModelJson(content);
      } catch {
        const reason = "JSON 無法解析";
        logFailedAttempt(model, attempt, reason, content);
        lastModelReason = reason;
        continue;
      }

      try {
        const normalized = normalizeResult(parsed);
        return {
          ...normalized,
          provider: `Cloudflare Workers AI (${model})`,
          notes: `${normalized.notes}${normalized.notes ? " " : ""}照片熱量為 Cloudflare Workers AI 估算，送出前請確認份量。`
        };
      } catch (error) {
        const msg = errorMessage(error);
        const reason = msg.includes("0 kcal") ? "0 kcal（未辨識出有效食物熱量）" : msg;
        logFailedAttempt(model, attempt, reason, content);
        lastModelReason = reason;
      }
    }

    if (lastModelReason) {
      modelFailures.push({ model: shortModelName(model), reason: lastModelReason });
    }

    if (Date.now() - startedAt >= DEFAULT_VISION_BUDGET_MS) {
      break;
    }
  }

  const summary = modelFailures.map((entry) => `${entry.model}：${entry.reason}`).join("；");
  throw new Error(
    `AI 照片分析失敗：所有模型都沒有回傳可用的結果（${summary || "無可用模型"}），請稍後再試或改用文字輸入。`
  );
}
