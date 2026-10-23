export interface StoredDocument<T = unknown> {
  updatedAt: string;
  data: T;
}

export interface DataStorage {
  get(key: string): Promise<StoredDocument | null>;
  /**
   * Store the document when its updatedAt is newer than or equal to the
   * stored timestamp. Returns the document that remains in storage.
   */
  saveNewer(key: string, document: StoredDocument): Promise<StoredDocument>;
}

export const CLOUD_STORAGE_NOT_CONFIGURED = "cloud storage not configured";

export class CloudStorageNotConfiguredError extends Error {
  readonly code = "CLOUD_STORAGE_NOT_CONFIGURED";

  constructor() {
    super(CLOUD_STORAGE_NOT_CONFIGURED);
    this.name = "CloudStorageNotConfiguredError";
  }
}

export function parseStoredDocument(value: unknown): StoredDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { updatedAt?: unknown; data?: unknown };
  if (typeof record.updatedAt !== "string" || Number.isNaN(Date.parse(record.updatedAt))) return null;
  if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) return null;
  return {
    updatedAt: new Date(record.updatedAt).toISOString(),
    data: record.data
  };
}

// ISO timestamps inside the stored JSON compare lexicographically.
// A strictly newer stored document is kept; equal timestamps take the incoming write.
const SAVE_NEWER_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current then
  local stamp = string.match(current, '^%{"updatedAt":"([^"]+)"')
  if stamp and stamp > ARGV[2] then
    return current
  end
end
redis.call("SET", KEYS[1], ARGV[1])
return ARGV[1]
`;

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
}>;

export class UpstashRedisStorage implements DataStorage {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  private endpoint() {
    return this.url.replace(/\/+$/, "");
  }

  private async command(args: string[]) {
    let response: { ok: boolean; status: number; json(): Promise<any> };
    try {
      response = await this.fetchImpl(this.endpoint(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(args)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "network error";
      throw new Error(`Upstash request failed: ${message}`);
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.error) {
      const reason = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
      throw new Error(`Upstash request failed: ${reason}`);
    }
    return payload.result;
  }

  async get(key: string): Promise<StoredDocument | null> {
    const result = await this.command(["GET", key]);
    if (result == null) return null;
    if (typeof result !== "string") {
      throw new Error("Upstash returned an unreadable document");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result);
    } catch {
      throw new Error("Upstash returned an unreadable document");
    }
    const document = parseStoredDocument(parsed);
    if (!document) throw new Error("Upstash returned an invalid document");
    return document;
  }

  async saveNewer(key: string, document: StoredDocument): Promise<StoredDocument> {
    const payload = JSON.stringify(document);
    const result = await this.command([
      "EVAL",
      SAVE_NEWER_SCRIPT,
      "1",
      key,
      payload,
      document.updatedAt
    ]);
    if (typeof result !== "string") {
      throw new Error("Upstash returned an unreadable document");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result);
    } catch {
      throw new Error("Upstash returned an unreadable document");
    }
    const stored = parseStoredDocument(parsed);
    if (!stored) throw new Error("Upstash returned an invalid document");
    return stored;
  }
}

export function createDataStorage(env: NodeJS.ProcessEnv = process.env): DataStorage {
  const adapter = (env.DATA_STORAGE_ADAPTER || "").trim().toLowerCase();
  if (adapter === "upstash") {
    const url = env.UPSTASH_REDIS_REST_URL?.trim() || "";
    const token = env.UPSTASH_REDIS_REST_TOKEN?.trim() || "";
    if (!url || !token) throw new CloudStorageNotConfiguredError();
    return new UpstashRedisStorage(url, token);
  }
  throw new CloudStorageNotConfiguredError();
}
