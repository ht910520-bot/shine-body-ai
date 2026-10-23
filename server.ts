import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { handleUserData } from "./lib/userDataApi.js";
import { analyzeFoodImage, MISSING_NVIDIA_KEY_ERROR } from "./lib/analyzeFoodImage.js";
import { analyzeFoodText } from "./lib/analyzeFoodText.js";

dotenv.config();

function hasNvidiaKey() {
  return Boolean(process.env.NVIDIA_API_KEY || process.env.NVIDIA_DEEPSEEK_API_KEY);
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  // Railway uses this route to verify that the service is ready.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "shine-body-ai" });
  });

  // Set limits for base64 food image payloads
  app.use(express.json({ limit: "15mb" }));

  app.all("/api/data", (req, res) => {
    void handleUserData(req, res);
  });

  const analysisRequests = new Map<string, { count: number; resetAt: number }>();
  const tooManyRequests = (req: express.Request) => {
    const now = Date.now();
    const client = req.ip || req.socket.remoteAddress || "unknown";
    const usage = analysisRequests.get(client);
    if (!usage || usage.resetAt <= now) {
      analysisRequests.set(client, { count: 1, resetAt: now + 60 * 60 * 1000 });
      return false;
    }
    if (usage.count >= 20) return true;
    usage.count += 1;
    return false;
  };

  app.post("/api/analyze-food", async (req, res) => {
    try {
      if (tooManyRequests(req)) {
        return res.status(429).json({ error: "分析次數過多，請一小時後再試。" });
      }
      if (!hasNvidiaKey()) {
        return res.status(500).json({ error: MISSING_NVIDIA_KEY_ERROR });
      }

      const { image, mimeType } = req.body || {};
      if (!image || typeof image !== "string") {
        return res.status(400).json({ error: "請提供食物照片。" });
      }

      const result = await analyzeFoodImage(image, mimeType);
      return res.json(result);
    } catch (err: any) {
      console.error("AI Analysis error:", err);
      return res.status(500).json({ error: `AI 照片分析失敗: ${err?.message || err}` });
    }
  });

  app.post("/api/analyze-food-text", async (req, res) => {
    try {
      if (tooManyRequests(req)) {
        return res.status(429).json({ error: "分析次數過多，請一小時後再試。" });
      }
      if (!hasNvidiaKey()) {
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
      return res.json(result);
    } catch (err: any) {
      console.error("AI text food analysis error:", err);
      return res.status(500).json({ error: `AI 飲食查詢失敗: ${err?.message || err}` });
    }
  });

  // Vite development middleware vs Static Production files
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
