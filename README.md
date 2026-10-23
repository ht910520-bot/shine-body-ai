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
2. Set `NVIDIA_API_KEY` in [.env.local](.env.local) to your NVIDIA API key
3. Run the app:
   `npm run dev`

## Railway

The included `Dockerfile` and `railway.json` deploy the React frontend and
Express API as one Railway service. Configure `NVIDIA_API_KEY` as a Railway
environment variable; never commit a real key to GitHub.

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

## NVIDIA food analysis

Photo and text analysis use NVIDIA NIM only. Set `NVIDIA_API_KEY`, or the
alternate `NVIDIA_DEEPSEEK_API_KEY`, to the same NVIDIA endpoint key. If
neither is set, the API returns `伺服器尚未設定 NVIDIA_API_KEY 或 NVIDIA_DEEPSEEK_API_KEY。`
There is no Gemini fallback.

Food-photo analysis tries `minimaxai/minimax-m3.1-flash`, then
`meta/muse-glimmer-30b`, then `meta/llama-3.2-90b-vision-instruct`. The first
valid result stops the chain. `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` is
retired, and `meta/llama-3.2-11b-vision-instruct` is too slow for the 60-second
function limit, so neither is in the default chain. Each request defaults to
45 seconds and can be raised to 50 seconds. The whole chain defaults to 55
seconds, under the Hobby `maxDuration` of 60. MiniMax spends completion tokens
on reasoning before it writes the JSON, so `max_tokens` defaults to 3000.
A 700-token cap returns `finish_reason=length` and empty content. Override the
chain with `NVIDIA_VISION_MODELS`, the fallback list with
`NVIDIA_VISION_FALLBACK_MODELS` (or the legacy `NVIDIA_VISION_FALLBACK_MODEL`),
the per-request timeout with `NVIDIA_VISION_TIMEOUT_MS`, the chain budget with
`NVIDIA_VISION_TOTAL_TIMEOUT_MS`, and the token cap with
`NVIDIA_VISION_MAX_TOKENS`. An empty reply or `finish_reason=length` is logged
with `finish_reason` and token usage, and the API error names the last NVIDIA
model failure.

Natural-language meal lookup uses `nvidia/mistral-nemo-minitron-8b-8k-instruct`.
`meta/llama-3.1-8b-instruct` is no longer listed by NVIDIA's `/v1/models`
endpoint. The text request defaults to 12 seconds and 1200 output tokens, with
upper limits of 25 seconds and 4096 tokens so it stays inside the 30-second
text function. Override it with `NVIDIA_MODEL`, `NVIDIA_TEXT_TIMEOUT_MS`, and
`NVIDIA_TEXT_MAX_TOKENS`. The same empty-content and `finish_reason=length`
logging applies. Lookup is an estimate from the model and does not search the
live web.
