import {
  CLOUD_STORAGE_NOT_CONFIGURED,
  CloudStorageNotConfiguredError,
  createDataStorage,
  parseStoredDocument,
  type DataStorage,
  type StoredDocument
} from "./storage.js";
import { isValidSession } from "./sessionAuth.js";

const STORAGE_KEY = "shine:app-data";
const MAX_DOCUMENT_BYTES = 3_500_000;

export interface DataApiRequest {
  method?: string;
  headers: { cookie?: string | string[] };
  body?: unknown;
}

export interface DataApiResponse {
  headersSent?: boolean;
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): unknown };
}

function send(res: DataApiResponse, status: number, body: unknown) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

function readJsonBody(body: unknown) {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body;
}

export async function handleUserData(req: DataApiRequest, res: DataApiResponse, storageOverride?: DataStorage) {
  try {
    if (!isValidSession(req.headers?.cookie)) {
      return send(res, 401, { error: "請先登入。" });
    }

    const method = (req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "PUT") {
      res.setHeader("Allow", "GET, PUT");
      return send(res, 405, { error: "只接受 GET 與 PUT 請求。" });
    }

    let storage: DataStorage;
    try {
      storage = storageOverride ?? createDataStorage();
    } catch (error) {
      if (error instanceof CloudStorageNotConfiguredError) {
        return send(res, 503, { error: CLOUD_STORAGE_NOT_CONFIGURED });
      }
      throw error;
    }

    if (method === "GET") {
      const document = await storage.get(STORAGE_KEY);
      if (!document) return send(res, 200, { updatedAt: null, data: null });
      return send(res, 200, { updatedAt: document.updatedAt, data: document.data });
    }

    const incoming = parseStoredDocument(readJsonBody(req.body));
    if (!incoming) return send(res, 400, { error: "資料格式不正確。" });
    if (Buffer.byteLength(JSON.stringify(incoming), "utf8") > MAX_DOCUMENT_BYTES) {
      return send(res, 413, { error: "資料太大，無法同步。" });
    }

    const stored = await storage.saveNewer(STORAGE_KEY, incoming);
    const saved = stored.updatedAt === incoming.updatedAt;
    return send(res, 200, {
      ok: true,
      saved,
      updatedAt: stored.updatedAt,
      data: stored.data
    });
  } catch (error) {
    console.error("Cloud data request failed:", error instanceof Error ? error.message : "unknown");
    if (res.headersSent) return;
    return send(res, 500, { error: "雲端同步失敗。" });
  }
}

export type { StoredDocument };
