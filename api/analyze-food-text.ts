import { analyzeFoodText, MISSING_NVIDIA_KEY_ERROR } from "../lib/analyzeFoodText.js";


export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "只接受 POST 請求。" });
  }


  try {
    const nvidiaApiKey = process.env.NVIDIA_API_KEY || process.env.NVIDIA_DEEPSEEK_API_KEY;
    if (!nvidiaApiKey) {
      return res.status(500).json({ error: MISSING_NVIDIA_KEY_ERROR });
    }


    const { text, followUpAnswer, previous } = req.body || {};
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "請輸入餐點名稱或描述。" });
    }
    if (text.length > 500) {
      return res.status(400).json({ error: "餐點描述請控制在 500 字以內。" });
    }


    const result = await analyzeFoodText(text, followUpAnswer, previous);
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("AI text food analysis error:", error);
    return res.status(500).json({ error: `AI 飲食查詢失敗: ${error?.message || error}` });
  }
}
