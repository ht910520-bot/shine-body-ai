import express from "express";
import path from "path";
import { existsSync } from "fs";
import dotenv from "dotenv";
import { authorizeRequest } from "./lib/accessGate.js";
import { handleApi, type RuntimeEnv } from "./lib/apiRoutes.js";
import { aiEnvFromProcess } from "./lib/cloudflareAi.js";

dotenv.config();
dotenv.config({ path: ".dev.vars" });

function runtimeEnv(): RuntimeEnv {
  return {
    ...aiEnvFromProcess(),
    APP_ACCESS_CODE: process.env.APP_ACCESS_CODE,
    DATA_STORAGE_ADAPTER: process.env.DATA_STORAGE_ADAPTER,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN
  };
}

function headerText(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.join(", ");
  return value || "";
}

function toWebRequest(req: express.Request, includeBody: boolean) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  if (!headers.has("x-forwarded-for") && req.ip) headers.set("x-forwarded-for", req.ip);
  if (!headers.has("cookie")) headers.set("cookie", headerText(req.headers.cookie));
  const method = req.method.toUpperCase();
  const init: RequestInit = { method, headers };
  if (includeBody && method !== "GET" && method !== "HEAD") {
    init.body = JSON.stringify(req.body ?? {});
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return new Request(new URL(req.originalUrl || req.url, `http://${req.headers.host || "localhost"}`), init);
}

async function writeNodeResponse(res: express.Response, response: Response) {
  res.status(response.status);
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  if (cookies.length) res.setHeader("set-cookie", cookies);
  const body = await response.text();
  res.send(body);
}

function clientDist() {
  const nested = path.join(process.cwd(), "dist", "client");
  if (existsSync(path.join(nested, "index.html"))) return nested;
  return path.join(process.cwd(), "dist");
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  app.use(express.json({ limit: "16mb" }));
  app.use((error: { type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error?.type === "entity.too.large") {
      res.status(413).json({ error: "照片檔案太大，請重新選擇照片。" });
      return;
    }
    next(error);
  });

  app.use(async (req, res, next) => {
    const denied = authorizeRequest(toWebRequest(req, false), process.env.APP_ACCESS_CODE || "");
    if (!denied) {
      next();
      return;
    }
    await writeNodeResponse(res, denied);
  });

  app.use("/api", async (req, res) => {
    try {
      const response = await handleApi(toWebRequest(req, true), runtimeEnv());
      await writeNodeResponse(res, response);
    } catch (error) {
      console.error(JSON.stringify({
        event: "express_api_failed",
        message: error instanceof Error ? error.message : "unknown"
      }));
      if (!res.headersSent) res.status(500).json({ error: "伺服器錯誤。" });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const [{ default: react }, { default: tailwindcss }, { createServer }] = await Promise.all([
      import("@vitejs/plugin-react"),
      import("@tailwindcss/vite"),
      import("vite")
    ]);
    const vite = await createServer({
      configFile: false,
      server: { middlewareMode: true },
      appType: "spa",
      plugins: [react(), tailwindcss()],
      resolve: {
        alias: { "@": path.resolve(".") }
      }
    });
    app.use(vite.middlewares);
  } else {
    const distPath = clientDist();
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
