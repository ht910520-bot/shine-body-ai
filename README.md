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

Food-photo analysis uses NVIDIA NIM when `NVIDIA_API_KEY` is configured. It
defaults to `meta/llama-3.2-11b-vision-instruct` and stops an individual model
request after 15 seconds. Optionally set `NVIDIA_VISION_FALLBACK_MODEL` to one
additional model and `NVIDIA_VISION_TIMEOUT_MS` (1,000–25,000 ms) in your
deployment environment.
