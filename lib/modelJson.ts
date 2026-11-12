const UNREADABLE_JSON_ERROR = "AI 沒有回傳可讀取的 JSON。";

function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let lookahead = i + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) {
        lookahead += 1;
      }
      const next = text[lookahead];
      if (next === "}" || next === "]") {
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function tryParseJsonObject(candidate: string): Record<string, any> | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  for (const variant of [trimmed, stripTrailingCommas(trimmed)]) {
    try {
      const parsed = JSON.parse(variant);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
    } catch {
      // Try next variant or candidate
    }
  }
  return null;
}

function scanBalancedJsonObjects(text: string): Record<string, any> | null {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") inString = false;
        continue;
      }
      if (character === "\"") inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParseJsonObject(text.slice(start, index + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }
  return null;
}

export function parseModelJson(input: unknown): any {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, any>;
  }
  if (typeof input !== "string") {
    throw new Error(UNREADABLE_JSON_ERROR);
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(UNREADABLE_JSON_ERROR);
  }

  const direct = tryParseJsonObject(trimmed);
  if (direct) return direct;

  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of trimmed.matchAll(fenceRegex)) {
    const block = match[1]?.trim() || "";
    const parsedBlock = tryParseJsonObject(block) || scanBalancedJsonObjects(block);
    if (parsedBlock) return parsedBlock;
  }

  const strippedFences = trimmed.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const parsedStripped = tryParseJsonObject(strippedFences)
    || scanBalancedJsonObjects(strippedFences)
    || scanBalancedJsonObjects(trimmed);
  if (parsedStripped) return parsedStripped;

  throw new Error(UNREADABLE_JSON_ERROR);
}
