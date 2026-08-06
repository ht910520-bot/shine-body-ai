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
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Railway

The included `Dockerfile` and `railway.json` deploy the React frontend and
Express API as one Railway service. Configure `GEMINI_API_KEY` as a Railway
environment variable; never commit a real key to GitHub.

Health check: `/api/health`

## NVIDIA image analysis

Food-photo analysis uses NVIDIA NIM when `NVIDIA_API_KEY` is configured. The
default model chain is `nvidia/llama-3.1-nemotron-nano-vl-8b-v1`, followed by
`meta/llama-3.2-11b-vision-instruct` and
`meta/llama-3.2-90b-vision-instruct`; the first valid result stops the chain.
Each request is capped at 15 seconds and the complete NVIDIA chain is capped
at 40 seconds. Set `NVIDIA_VISION_MODELS` to replace the full chain, or set
`NVIDIA_VISION_FALLBACK_MODELS` to replace the fallback list. The legacy
`NVIDIA_VISION_FALLBACK_MODEL` variable is still supported.

Natural-language meal lookup uses the faster `meta/llama-3.1-8b-instruct`
model by default and gives the NVIDIA request a 12-second limit before using
the Gemini fallback. Override it with `NVIDIA_MODEL` and
`NVIDIA_TEXT_TIMEOUT_MS` when needed. NVIDIA lookup is an estimate and does
not perform live product-label search; Gemini is the route that can use web
grounding.
