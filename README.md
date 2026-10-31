# 閃耀體態 AI 飲食卡路里管家

The app is a Vite + React SPA and a JSON API on one Cloudflare Worker. Photo and text analysis use Workers AI. Login still checks the existing `APP_ACCESS_CODE` and stores the same SHA-256 session cookie. Diet records stay on this device unless Upstash REST credentials are set.

Vercel is not the host. `vercel.json` and the old `api/` serverless functions are gone. If a Vercel project is still connected to this repo, disconnect it after the Worker URL is live. A failed Vercel build leaves the last successful Vercel deployment in place; it is not the new app.

## Deploy to Cloudflare

Prerequisites: Node.js 22, pnpm 11, and a Cloudflare account with Workers and Workers AI enabled.

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Log in so Wrangler can deploy:

   ```bash
   pnpm exec wrangler login
   ```

3. The first time this account calls Llama 3.2 11B Vision, accept Meta's license. Use your own account id and a token with Workers AI Read and Edit. Do not commit either value.

   ```bash
   curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/meta/llama-3.2-11b-vision-instruct" \
     -X POST \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"prompt":"agree"}'
   ```

4. Set the existing app password as a Worker secret. Use the password people already use. A new value invalidates current sessions because the cookie is `SHA-256(APP_ACCESS_CODE)`.

   ```bash
   pnpm exec wrangler secret put APP_ACCESS_CODE
   ```

5. Build and deploy. `pnpm run deploy` builds the Vite app and runs `wrangler deploy`, which publishes the Worker and the static assets. The command prints a `*.workers.dev` URL such as `https://shine-body-ai.<account-subdomain>.workers.dev`. `pnpm dev` also needs this login: the local AI binding calls your Cloudflare account.

   ```bash
   pnpm run deploy
   ```

   To check the production bundle without publishing:

   ```bash
   pnpm run build
   pnpm exec wrangler deploy --dry-run
   ```

6. Open the printed URL, sign in with the existing password, then try a text lookup and a food photo.

### Workers Builds

In the Cloudflare dashboard, create a Worker connected to this Git repository (Workers Builds).

| Setting | Command |
| --- | --- |
| Build command | `pnpm run build` |
| Deploy command | `pnpm exec wrangler deploy` |

Runtime secrets are not build variables. Set them under the Worker **Settings → Variables and Secrets** before the first deploy, using the same names as below. Non-secret model ids are already in `wrangler.jsonc` `vars`.

### Secrets and variables

| Name | Required on the Worker | Purpose |
| --- | --- | --- |
| `APP_ACCESS_CODE` | Yes | Existing shared login password. Secret. |
| `CLOUDFLARE_VISION_MODEL` | No | Default `@cf/meta/llama-3.2-11b-vision-instruct` in `wrangler.jsonc`. |
| `CLOUDFLARE_TEXT_MODEL` | No | Default `@cf/meta/llama-3.1-8b-instruct-fast` in `wrangler.jsonc`. |
| `UPSTASH_REDIS_REST_URL` | No | Optional cloud sync. Secret, with its token. |
| `UPSTASH_REDIS_REST_TOKEN` | No | Pairs with the URL above. |
| `KV_REST_API_URL` | No | Alternate Upstash REST pair. Ignored when `UPSTASH_REDIS_REST_*` is complete. |
| `KV_REST_API_TOKEN` | No | Pairs with `KV_REST_API_URL`. |
| `DATA_STORAGE_ADAPTER` | No | Set to `upstash` only to require Upstash. Leave unset to auto-enable when a full credential pair exists. |
| `CLOUDFLARE_ACCOUNT_ID` | No | REST fallback for Express/Docker only. The Worker uses the `AI` binding. `CF_ACCOUNT_ID` is an alias. |
| `CLOUDFLARE_API_TOKEN` | No | REST fallback for Express/Docker only. Workers AI Read + Edit. `CF_API_TOKEN` and `CLOUDFLARE_AUTH_TOKEN` are aliases. |

On the Worker, `env.AI.run` is used for every analysis. The REST token is not read unless the `AI` binding is absent.

Optional tuning secrets: `CLOUDFLARE_VISION_MAX_TOKENS` (default 2048), `CLOUDFLARE_VISION_TIMEOUT_MS` (default 45000), `CLOUDFLARE_TEXT_MAX_TOKENS` (default 1200), `CLOUDFLARE_TEXT_TIMEOUT_MS` (default 20000).

Add a custom domain from the dashboard or with a `routes` / `workers_dev` change in `wrangler.jsonc`. Preview URLs from Workers Builds are public unless you put Cloudflare Access in front of them.

After changing bindings, regenerate types:

```bash
pnpm run cf-typegen
```

## Run locally

`pnpm dev` starts Vite with the Cloudflare plugin, so the API runs in the Workers runtime and calls the `AI` binding. That binding reaches your Cloudflare account and can incur Workers AI usage.

```bash
pnpm install
cp .env.example .dev.vars
# edit .dev.vars and set APP_ACCESS_CODE to the existing password
pnpm dev
```

`pnpm dev:express` is the Node fallback. It does not receive the `AI` binding. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in `.env` or `.dev.vars` so analysis uses the Workers AI REST API. The same login cookie and `/api/*` routes apply.

```bash
pnpm run dev:express
```

`pnpm run preview` serves the production build locally. `pnpm run build` is the Worker production build.

## API

| Method and path | Auth | Behavior |
| --- | --- | --- |
| `GET /api/health` | Public | `{ ok, service: "shine-body-ai", platform: "cloudflare" }` |
| `POST /api/login` | Public | Compares the password with `APP_ACCESS_CODE` and sets `shine_auth` |
| `POST /api/logout` | Public | Clears `shine_auth` |
| `POST /api/analyze-food` | Session | Photo JSON in, meal estimate JSON out. About 20 analyses per hour per client. |
| `POST /api/analyze-food-text` | Session | Text lookup. `needs_confirmation` still asks one follow-up question. |
| `GET` or `PUT /api/data` | Session | Cloud sync document. `503` when Upstash is unset. |

Every other path redirects to `/login.html` until the session cookie matches. The limit is enforced in the Worker isolate, same as the old single-process counter: it is about 20 successful analysis calls per hour per client IP, then `429`.

Photo responses still use `food`, `items`, `totalCalories`, `confidence`, `notes`, and `provider`. A zero-calorie photo is rejected. Text responses still use `status`, `question`, `food`, `confidence`, `notes`, `provider`, and `sources`. The model is not connected to live web search.

## Cloud sync

Logged-in diet, weight, and history records can sync across devices. The API stores one JSON document per deployment behind `GET`/`PUT /api/data`. Without the Upstash settings above, the app keeps using this browser and shows 「僅本機」.

Conflicts keep the document with the newer `updatedAt`. An empty cloud account imports existing on-device data once. Importing a JSON backup uploads it too.

## Optional Docker image

`Dockerfile` and `railway.json` are not the primary host. `pnpm run build:server` builds the SPA and a Node server that serves it and calls Workers AI over REST. Set `APP_ACCESS_CODE`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN` on that service. Health check: `/api/health`.
