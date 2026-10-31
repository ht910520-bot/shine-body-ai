import { handleWorkerRequest, type WorkerRuntime } from "../lib/workerApp.js";

function readString(env: Env, key: string) {
  const value = Reflect.get(env, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function runtimeFromEnv(env: Env): WorkerRuntime {
  return {
    AI: {
      run(model, input) {
        return env.AI.run(model, input);
      }
    },
    ASSETS: {
      fetch(request) {
        return env.ASSETS.fetch(request);
      }
    },
    APP_ACCESS_CODE: readString(env, "APP_ACCESS_CODE"),
    CLOUDFLARE_ACCOUNT_ID: readString(env, "CLOUDFLARE_ACCOUNT_ID") || readString(env, "CF_ACCOUNT_ID"),
    CLOUDFLARE_API_TOKEN: readString(env, "CLOUDFLARE_API_TOKEN") || readString(env, "CF_API_TOKEN") || readString(env, "CLOUDFLARE_AUTH_TOKEN"),
    CLOUDFLARE_VISION_MODEL: env.CLOUDFLARE_VISION_MODEL,
    CLOUDFLARE_TEXT_MODEL: env.CLOUDFLARE_TEXT_MODEL,
    CLOUDFLARE_VISION_MAX_TOKENS: readString(env, "CLOUDFLARE_VISION_MAX_TOKENS"),
    CLOUDFLARE_TEXT_MAX_TOKENS: readString(env, "CLOUDFLARE_TEXT_MAX_TOKENS"),
    CLOUDFLARE_VISION_TIMEOUT_MS: readString(env, "CLOUDFLARE_VISION_TIMEOUT_MS"),
    CLOUDFLARE_TEXT_TIMEOUT_MS: readString(env, "CLOUDFLARE_TEXT_TIMEOUT_MS"),
    DATA_STORAGE_ADAPTER: readString(env, "DATA_STORAGE_ADAPTER"),
    UPSTASH_REDIS_REST_URL: readString(env, "UPSTASH_REDIS_REST_URL"),
    UPSTASH_REDIS_REST_TOKEN: readString(env, "UPSTASH_REDIS_REST_TOKEN"),
    KV_REST_API_URL: readString(env, "KV_REST_API_URL"),
    KV_REST_API_TOKEN: readString(env, "KV_REST_API_TOKEN")
  };
}

export default {
  async fetch(request, env) {
    return handleWorkerRequest(request, runtimeFromEnv(env));
  }
} satisfies ExportedHandler<Env>;
