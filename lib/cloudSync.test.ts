import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CLOUD_REFRESH_INTERVAL_MS,
  CLOUD_STORAGE_NOT_CONFIGURED,
  interpretCloudResponse,
  mergeCloudPayload,
  mergeWeightHistory,
  planSync
} from "../src/cloudSync.ts";
import {
  CloudStorageNotConfiguredError,
  UpstashRedisStorage,
  createDataStorage,
  upstashRestCredentials,
  type DataStorage,
  type StoredDocument
} from "./storage.ts";
import { handleUserData, type DataApiResponse } from "./userDataApi.ts";
import { sessionTokenFor } from "./sessionAuth.ts";

class MemoryStorage implements DataStorage {
  private readonly values = new Map<string, StoredDocument>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async saveNewer(key: string, document: StoredDocument) {
    const current = this.values.get(key);
    if (current && current.updatedAt > document.updatedAt) return current;
    this.values.set(key, document);
    return document;
  }
}

function mockResponse() {
  const res = {
    statusCode: 0,
    body: null as any,
    setHeader() {
      return;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return body;
    }
  };
  return res as DataApiResponse & typeof res;
}

function cookieFor(accessCode: string) {
  return `shine_auth=${sessionTokenFor(accessCode)}`;
}

const originalEnv = {
  APP_ACCESS_CODE: process.env.APP_ACCESS_CODE,
  DATA_STORAGE_ADAPTER: process.env.DATA_STORAGE_ADAPTER,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  KV_REST_API_URL: process.env.KV_REST_API_URL,
  KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function testDecision() {
  assert.ok(CLOUD_REFRESH_INTERVAL_MS >= 30_000 && CLOUD_REFRESH_INTERVAL_MS <= 60_000);

  assert.equal(planSync({
    cloud: "empty",
    localUpdatedAt: null,
    cloudUpdatedAt: null,
    hasPersistedLocal: false,
    dirty: false
  }), "keep");

  assert.equal(planSync({
    cloud: "empty",
    localUpdatedAt: null,
    cloudUpdatedAt: null,
    hasPersistedLocal: true,
    dirty: false
  }), "upload-local");

  assert.equal(planSync({
    cloud: "present",
    localUpdatedAt: null,
    cloudUpdatedAt: "2026-10-23T00:00:00.000Z",
    hasPersistedLocal: true,
    dirty: false
  }), "apply-cloud");

  assert.equal(planSync({
    cloud: "present",
    localUpdatedAt: "2026-10-23T02:00:00.000Z",
    cloudUpdatedAt: "2026-10-23T01:00:00.000Z",
    hasPersistedLocal: true,
    dirty: false
  }), "upload-local");

  assert.equal(planSync({
    cloud: "present",
    localUpdatedAt: "2026-10-23T15:57:13.000Z",
    cloudUpdatedAt: "2026-10-23T15:59:10.598Z",
    hasPersistedLocal: true,
    dirty: false
  }), "apply-cloud");

  assert.equal(planSync({
    cloud: "present",
    localUpdatedAt: "2026-10-23T15:57:13.000Z",
    cloudUpdatedAt: "2026-10-23T15:59:10.598Z",
    hasPersistedLocal: true,
    dirty: true
  }), "merge");

  assert.equal(planSync({
    cloud: "present",
    localUpdatedAt: "2026-10-23T16:00:00.000Z",
    cloudUpdatedAt: "2026-10-23T15:59:10.598Z",
    hasPersistedLocal: true,
    dirty: true
  }), "upload-local");

  assert.equal(planSync({
    cloud: "present",
    localUpdatedAt: "2026-10-23T15:59:10.598Z",
    cloudUpdatedAt: "2026-10-23T15:59:10.598Z",
    hasPersistedLocal: true,
    dirty: false
  }), "keep");

  const localWeights = [
    { date: "2026-07-17", weight: 64.2 },
    { date: "2026-10-05", weight: 62 }
  ];
  const cloudWeights = [
    { date: "2026-07-17", weight: 64.2 },
    { date: "2026-07-30", weight: 63.1 },
    { date: "2026-09-24", weight: 62.4 },
    { date: "2026-10-05", weight: 63 }
  ];
  const mergedWeights = mergeWeightHistory(localWeights, cloudWeights, "cloud");
  assert.deepEqual(mergedWeights.map((point) => point.date), [
    "2026-07-17",
    "2026-07-30",
    "2026-09-24",
    "2026-10-05"
  ]);
  assert.equal(mergedWeights.find((point) => point.date === "2026-10-05")?.weight, 63);

  const merged = mergeCloudPayload(
    {
      current: {
        date: "2026-10-23",
        foods: [{ name: "未上傳的早餐" }],
        weightHistory: [...localWeights, { date: "2026-10-20", weight: 61.2 }]
      },
      records: [{ id: "manual:local", snapshot: true }]
    },
    {
      current: {
        date: "2026-10-23",
        foods: [],
        weightHistory: cloudWeights
      },
      records: [{ id: "daily:2026-10-23", snapshot: true }]
    }
  );
  assert.deepEqual(merged.current.foods, [{ name: "未上傳的早餐" }]);
  assert.equal(merged.current.weightHistory.find((point) => point.date === "2026-10-20")?.weight, 61.2);
  assert.equal(merged.current.weightHistory.find((point) => point.date === "2026-10-05")?.weight, 63);
  assert.equal(merged.current.weightHistory.length, 5);
  assert.deepEqual(merged.records.map((record) => record.id).sort(), ["daily:2026-10-23", "manual:local"]);
}

async function testApi() {
  process.env.APP_ACCESS_CODE = "sync-test-code";
  delete process.env.DATA_STORAGE_ADAPTER;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  const unauthorized = mockResponse();
  await handleUserData({ method: "GET", headers: {} }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.body.error, "請先登入。");

  const wrongCookie = mockResponse();
  await handleUserData({ method: "GET", headers: { cookie: "shine_auth=nope" } }, wrongCookie);
  assert.equal(wrongCookie.statusCode, 401);

  const unconfigured = mockResponse();
  await handleUserData({ method: "GET", headers: { cookie: cookieFor("sync-test-code") } }, unconfigured);
  assert.equal(unconfigured.statusCode, 503);
  assert.equal(unconfigured.body.error, CLOUD_STORAGE_NOT_CONFIGURED);

  process.env.KV_REST_API_URL = "http://127.0.0.1:9";
  process.env.KV_REST_API_TOKEN = "marketplace-token";
  const autoSelected = mockResponse();
  await handleUserData({ method: "GET", headers: { cookie: cookieFor("sync-test-code") } }, autoSelected);
  assert.equal(autoSelected.statusCode, 500);
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  process.env.DATA_STORAGE_ADAPTER = "upstash";
  const missingToken = mockResponse();
  await handleUserData({ method: "GET", headers: { cookie: cookieFor("sync-test-code") } }, missingToken);
  assert.equal(missingToken.statusCode, 503);

  const storage = new MemoryStorage();
  const empty = mockResponse();
  await handleUserData({ method: "GET", headers: { cookie: cookieFor("sync-test-code") } }, empty, storage);
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.body, { updatedAt: null, data: null });

  const first = {
    updatedAt: "2026-10-23T01:00:00.000Z",
    data: { current: { foods: ["salad"] }, records: [] }
  };
  const saved = mockResponse();
  await handleUserData({ method: "PUT", headers: { cookie: cookieFor("sync-test-code") }, body: first }, saved, storage);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.saved, true);
  assert.equal(saved.body.updatedAt, first.updatedAt);

  const older = mockResponse();
  await handleUserData({
    method: "PUT",
    headers: { cookie: cookieFor("sync-test-code") },
    body: { updatedAt: "2026-10-23T00:30:00.000Z", data: { current: { foods: ["old"] } } }
  }, older, storage);
  assert.equal(older.statusCode, 200);
  assert.equal(older.body.saved, false);
  assert.deepEqual(older.body.data, first.data);

  const loaded = mockResponse();
  await handleUserData({ method: "GET", headers: { cookie: cookieFor("sync-test-code") } }, loaded, storage);
  assert.equal(loaded.body.updatedAt, first.updatedAt);
  assert.deepEqual(loaded.body.data, first.data);

  const newer = mockResponse();
  const next = { updatedAt: "2026-10-23T03:00:00.000Z", data: { current: { foods: ["soup"] } } };
  await handleUserData({ method: "PUT", headers: { cookie: cookieFor("sync-test-code") }, body: next }, newer, storage);
  assert.equal(newer.body.saved, true);
  assert.deepEqual(newer.body.data, next.data);

  const invalid = mockResponse();
  await handleUserData({ method: "PUT", headers: { cookie: cookieFor("sync-test-code") }, body: { updatedAt: "nope" } }, invalid, storage);
  assert.equal(invalid.statusCode, 400);

  const anonymousPost = mockResponse();
  await handleUserData({ method: "POST", headers: {} }, anonymousPost, storage);
  assert.equal(anonymousPost.statusCode, 401);

  const wrongMethod = mockResponse();
  await handleUserData({ method: "POST", headers: { cookie: cookieFor("sync-test-code") } }, wrongMethod, storage);
  assert.equal(wrongMethod.statusCode, 405);
}

async function testUpstashAdapter() {
  assert.throws(() => createDataStorage({} as NodeJS.ProcessEnv), CloudStorageNotConfiguredError);
  assert.throws(() => createDataStorage({ DATA_STORAGE_ADAPTER: "upstash" } as NodeJS.ProcessEnv), CloudStorageNotConfiguredError);
  assert.throws(() => createDataStorage({ KV_REST_API_URL: "https://kv.example" } as NodeJS.ProcessEnv), CloudStorageNotConfiguredError);
  assert.throws(() => createDataStorage({
    DATA_STORAGE_ADAPTER: "other",
    KV_REST_API_URL: "https://kv.example",
    KV_REST_API_TOKEN: "kv-token"
  } as NodeJS.ProcessEnv), CloudStorageNotConfiguredError);

  assert.equal(upstashRestCredentials({} as NodeJS.ProcessEnv), null);
  assert.deepEqual(upstashRestCredentials({
    KV_REST_API_URL: " https://kv.example ",
    KV_REST_API_TOKEN: " kv-token "
  } as NodeJS.ProcessEnv), { url: "https://kv.example", token: "kv-token" });
  assert.deepEqual(upstashRestCredentials({
    UPSTASH_REDIS_REST_URL: "https://upstash.example",
    UPSTASH_REDIS_REST_TOKEN: "upstash-token",
    KV_REST_API_URL: "https://kv.example",
    KV_REST_API_TOKEN: "kv-token"
  } as NodeJS.ProcessEnv), { url: "https://upstash.example", token: "upstash-token" });
  assert.deepEqual(upstashRestCredentials({
    UPSTASH_REDIS_REST_URL: "https://upstash.example",
    KV_REST_API_URL: "https://kv.example",
    KV_REST_API_TOKEN: "kv-token"
  } as NodeJS.ProcessEnv), { url: "https://kv.example", token: "kv-token" });

  assert.ok(createDataStorage({
    KV_REST_API_URL: "https://kv.example",
    KV_REST_API_TOKEN: "kv-token"
  } as NodeJS.ProcessEnv) instanceof UpstashRedisStorage);
  assert.ok(createDataStorage({
    UPSTASH_REDIS_REST_URL: "https://upstash.example",
    UPSTASH_REDIS_REST_TOKEN: "upstash-token"
  } as NodeJS.ProcessEnv) instanceof UpstashRedisStorage);
  assert.ok(createDataStorage({
    DATA_STORAGE_ADAPTER: "upstash",
    KV_REST_API_URL: "https://kv.example",
    KV_REST_API_TOKEN: "kv-token"
  } as NodeJS.ProcessEnv) instanceof UpstashRedisStorage);

  const calls: Array<{ url: string; authorization: string; body: string[] }> = [];
  let stored: string | null = null;
  const storage = new UpstashRedisStorage("https://example.upstash.io/", "secret-token", async (url, init) => {
    const body = JSON.parse(init?.body || "[]") as string[];
    calls.push({ url, authorization: init?.headers?.Authorization || "", body });
    if (body[0] === "GET") {
      return { ok: true, status: 200, json: async () => ({ result: stored }) };
    }
    const scriptKeepsCurrent = stored && JSON.parse(stored).updatedAt > body[5];
    const result = scriptKeepsCurrent ? stored : body[4];
    if (!scriptKeepsCurrent) stored = body[4];
    return { ok: true, status: 200, json: async () => ({ result }) };
  });

  assert.equal(await storage.get("shine:app-data"), null);
  const document = { updatedAt: "2026-10-23T04:00:00.000Z", data: { hello: "world" } };
  const saved = await storage.saveNewer("shine:app-data", document);
  assert.deepEqual(saved, document);
  assert.equal(calls[0].url, "https://example.upstash.io");
  assert.equal(calls[0].authorization, "Bearer secret-token");
  assert.deepEqual(calls[0].body.slice(0, 2), ["GET", "shine:app-data"]);
  assert.equal(calls[1].body[0], "EVAL");
  assert.equal(calls[1].body[2], "1");
  assert.equal(calls[1].body[3], "shine:app-data");

  const older = await storage.saveNewer("shine:app-data", {
    updatedAt: "2026-10-23T03:00:00.000Z",
    data: { hello: "old" }
  });
  assert.deepEqual(older, document);
  const loaded = await storage.get("shine:app-data");
  assert.deepEqual(loaded, document);

  assert.equal(createHash("sha256").update("sync-test-code").digest("hex"), sessionTokenFor("sync-test-code"));
}

async function testResponseParser() {
  const unconfigured = await interpretCloudResponse(new Response(JSON.stringify({ error: CLOUD_STORAGE_NOT_CONFIGURED }), {
    status: 503,
    headers: { "Content-Type": "application/json" }
  }));
  assert.equal(unconfigured.type, "unconfigured");

  const empty = await interpretCloudResponse(new Response(JSON.stringify({ updatedAt: null, data: null }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  }));
  assert.equal(empty.type, "empty");
}

async function main() {
  try {
    await testDecision();
    await testApi();
    await testUpstashAdapter();
    await testResponseParser();
  } finally {
    restoreEnv();
  }
  console.log("cloud sync tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
