<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# 閃耀體態 AI 飲食卡路里管家

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/b820f5a3-b823-4bdc-9c94-c54f06f3fa1c

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in [.env.local](.env.local)
3. Run the app:
   `npm run dev`

## Railway

The included `Dockerfile` and `railway.json` deploy the React frontend and
Express API as one Railway service. Configure `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` as environment variables; never commit a real token.

Health check: `/api/health`

## Cloud sync

Logged-in diet, weight, and history records can sync across devices. The API
stores one JSON document per deployment behind `GET`/`PUT /api/data`. Without
the storage settings below, the app keeps using this browser and shows
「僅本機」.

Sync turns on when either Upstash REST credential pair is present, so
`DATA_STORAGE_ADAPTER` is optional. Set `DATA_STORAGE_ADAPTER=upstash` only
to force that adapter. The Vercel Marketplace Upstash integration injects
`KV_REST_API_URL` and `KV_REST_API_TOKEN`. The same adapter also reads
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. When both pairs are
set, the `UPSTASH_REDIS_REST_*` pair is used. A URL without its matching
token does not enable sync. Leave every storage variable unset to keep
records on this device; the app then shows 「僅本機」. Do not commit the token.

Conflicts keep the document with the newer `updatedAt`. An empty cloud account
imports existing on-device data once. Importing a JSON backup uploads it too.

## Cloudflare Workers AI food analysis

Photo and text analysis call the Workers AI REST API:

`POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}`

with `Authorization: Bearer CLOUDFLARE_API_TOKEN`. Set these Vercel environment
variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_VISION_MODEL` (default `@cf/meta/llama-3.2-11b-vision-instruct`)
- `CLOUDFLARE_TEXT_MODEL` (default `@cf/meta/llama-3.1-8b-instruct-fast`)

`CF_ACCOUNT_ID` and `CF_API_TOKEN` are accepted aliases for the account id and
token. `CLOUDFLARE_AUTH_TOKEN` is also accepted as a token alias. If the
account id and token are both missing, the API returns
`伺服器尚未設定 CLOUDFLARE_ACCOUNT_ID 與 CLOUDFLARE_API_TOKEN。`

Food photos use one call to `@cf/meta/llama-3.2-11b-vision-instruct`. The
request times out at 50 seconds and asks for at most 768 tokens, under the
Hobby `maxDuration` of 60. There is no model fallback chain. The first time
that vision model is used on an account, Cloudflare requires accepting Meta's
license. Do that in the Workers AI dashboard, or with one authenticated
request whose JSON body is `{"prompt":"agree"}`.

Natural-language meal lookup uses `@cf/meta/llama-3.1-8b-instruct-fast`.
The unprefixed `@cf/meta/llama-3.1-8b-instruct` id is deprecated. The text
request times out at 20 seconds and asks for at most 512 tokens, inside the
30-second text function. If a key fact such as rice amount, frying, sauce, or portion size
is missing, the JSON `status` is `needs_confirmation` and `question` asks one
thing. Lookup is a model estimate and does not search the live web.
