import express from "express";
import path from "path";
import dotenv from "dotenv";
import analyzeFoodText from "./api/analyze-food-text.ts";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";

dotenv.config();

// Ensure Gemini API key is configured
const apiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;
if (apiKey) {
  ai = new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
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

  app.post("/api/analyze-food-text", async (req, res) => {
    await analyzeFoodText(req, res);
  });

  // AI Food Analysis API Endpoint
  const analysisRequests = new Map<string, { count: number; resetAt: number }>();
  app.post("/api/analyze-food", async (req, res) => {
    try {
      // Basic in-memory protection for a public, password-free endpoint.
      const now = Date.now();
      const client = req.ip || req.socket.remoteAddress || "unknown";
      const usage = analysisRequests.get(client);
      if (!usage || usage.resetAt <= now) {
        analysisRequests.set(client, { count: 1, resetAt: now + 60 * 60 * 1000 });
      } else if (usage.count >= 20) {
        return res.status(429).json({ error: "分析次數過多，請一小時後再試。" });
      } else {
        usage.count += 1;
      }

      const { image, mimeType } = req.body;

      // Check if GEMINI_API_KEY is available
      if (!process.env.GEMINI_API_KEY || !ai) {
        return res.status(500).json({ error: "伺服器尚未設定 GEMINI_API_KEY。" });
      }

      if (!image) {
        return res.status(400).json({ error: "請提供食物照片。" });
      }

      // 3. Call Gemini with automatic fallback
      let response;
      let usedModel = "gemini-3.5-flash";
      const imagePart = {
        inlineData: {
          mimeType: mimeType || "image/jpeg",
          data: image
        }
      };

      const promptPart = {
        text: "請分析這張食物照片，並估算其中包含的所有食物品項、卡路里（kcal）以及蛋白質、碳水、脂肪（公克）。請以繁體中文撰寫食物名稱與說明。"
      };

      const generateConfig = {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING, description: "食物或配菜名稱" },
                  calories: { type: Type.INTEGER, description: "估算熱量 (kcal)" },
                  protein: { type: Type.NUMBER, description: "估算蛋白質 (g)" },
                  carbs: { type: Type.NUMBER, description: "估算碳水化合物 (g)" },
                  fat: { type: Type.NUMBER, description: "估算脂肪 (g)" }
                },
                required: ["name", "calories", "protein", "carbs", "fat"]
              }
            },
            totalCalories: { type: Type.INTEGER, description: "總熱量估算 (kcal)" },
            confidence: { type: Type.STRING, description: "置信度，例如 High, Medium, Low" },
            notes: { type: Type.STRING, description: "分析備註或飲食建議" },
            food: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING, description: "主餐點名稱，例如：炸雞排便當" },
                calories: { type: Type.INTEGER, description: "總熱量 (kcal)" },
                protein: { type: Type.NUMBER, description: "總蛋白質 (g)" },
                carbs: { type: Type.NUMBER, description: "總碳水 (g)" },
                fat: { type: Type.NUMBER, description: "總脂肪 (g)" },
                description: { type: Type.STRING, description: "整體分析說明" }
              },
              required: ["name", "calories", "protein", "carbs", "fat", "description"]
            }
          },
          required: ["items", "totalCalories", "confidence", "notes", "food"]
        }
      };

      try {
        console.log("Attempting image analysis with gemini-3.5-flash...");
        response = await ai.models.generateContent({
          model: "gemini-3.5-flash",
          contents: [imagePart, promptPart],
          config: generateConfig
        });
      } catch (firstErr: any) {
        console.warn("gemini-3.5-flash failed or experienced high demand. Trying fallback model gemini-flash-latest...", firstErr.message || firstErr);
        try {
          usedModel = "gemini-flash-latest";
          response = await ai.models.generateContent({
            model: "gemini-flash-latest",
            contents: [imagePart, promptPart],
            config: generateConfig
          });
        } catch (secondErr: any) {
          console.warn("gemini-flash-latest failed. Trying fallback model gemini-3.1-flash-lite...", secondErr.message || secondErr);
          usedModel = "gemini-3.1-flash-lite";
          response = await ai.models.generateContent({
            model: "gemini-3.1-flash-lite",
            contents: [imagePart, promptPart],
            config: generateConfig
          });
        }
      }

      const responseText = response.text;
      if (!responseText) {
        throw new Error("Gemini 未回傳任何文字內容。");
      }

      const parsedData = JSON.parse(responseText.trim());
      
      // Return with expected structure
      return res.json({
        food: parsedData.food,
        provider: `Gemini AI (${usedModel})`,
        items: parsedData.items,
        totalCalories: parsedData.totalCalories,
        confidence: parsedData.confidence,
        notes: parsedData.notes
      });

    } catch (err: any) {
      console.error("AI Analysis error:", err);
      return res.status(500).json({ error: `AI 分析失敗: ${err.message || err}` });
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

