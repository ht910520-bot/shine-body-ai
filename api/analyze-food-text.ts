import { GoogleGenAI } from "@google/genai";
// Vercel's native ESM runtime needs the emitted .js extension for local imports.
import { analyzeFoodText } from "../lib/analyzeFoodText.js";


export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "只接受 POST 請求。" });
  }


  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const nvidiaApiKey = process.env.NVIDIA_API_KEY || process.env.NVIDIA_DEEPSEEK_API_KEY;
    if (!apiKey && !nvidiaApiKey) {
      return res.status(500).json({ error: "伺服器尚未設定 NVIDIA_API_KEY 或 GEMINI_API_KEY。" });
    }


    const { text, followUpAnswer, previous } = req.body || {};
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "請輸入餐點名稱或描述。" });
    }
    if (text.length > 500) {
      return res.status(400).json({ error: "餐點描述請控制在 500 字以內。" });
    }


    const ai = apiKey
      ? new GoogleGenAI({
          apiKey,
          httpOptions: { headers: { "User-Agent": "shine-body-ai-vercel" } }
        })
      : null;
    const result = await analyzeFoodText(ai, text, followUpAnswer, previous);
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("AI text food analysis error:", error);
    return res.status(500).json({ error: `AI 飲食查詢失敗: ${error?.message || error}` });
  }
}

