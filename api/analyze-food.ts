import { GoogleGenAI } from "@google/genai";
import { analyzeFoodImage } from "../lib/analyzeFoodImage.js";


export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "只接受 POST 請求。" });
  }


  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const nvidiaApiKey = process.env.NVIDIA_API_KEY || process.env.NVIDIA_DEEPSEEK_API_KEY;
    if (!apiKey && !nvidiaApiKey) {
      return res.status(500).json({ error: "伺服器尚未設定 NVIDIA API key 或 GEMINI_API_KEY。" });
    }


    const { image, mimeType } = req.body || {};
    if (!image || typeof image !== "string") {
      return res.status(400).json({ error: "請提供食物照片。" });
    }
    if (image.length > 15_000_000) {
      return res.status(413).json({ error: "照片檔案太大，請重新選擇照片。" });
    }


    const ai = apiKey
      ? new GoogleGenAI({
          apiKey,
          httpOptions: { headers: { "User-Agent": "shine-body-ai-vercel" } }
        })
      : null;
    const result = await analyzeFoodImage(ai, image, mimeType);
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("AI image analysis error:", error);
    return res.status(500).json({ error: `AI 照片分析失敗: ${error?.message || error}` });
  }
}

