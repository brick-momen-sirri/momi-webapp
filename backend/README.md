# Momi Animation Backend

Node/Express backend for routing generation jobs to a RunPod serverless ComfyUI worker.

## Run

```powershell
pnpm --filter momi-animation-backend dev
```

Default API URL:

```text
http://127.0.0.1:3333
```

The frontend reads `VITE_API_BASE_URL` and falls back to `http://127.0.0.1:3333`.

## RunPod Serverless ComfyUI

Generation jobs default to RunPod serverless. Configure the backend process with server-side environment variables:

```text
RUNPOD_ENDPOINT_ID=<your RunPod endpoint id>
RUNPOD_API_KEY=<your RunPod API key>
COMFY_ORG_API_KEY=<your Comfy org API key>
RUNPOD_POLL_INTERVAL_MS=5000
RUNPOD_TIMEOUT_MS=2400000
SERVERLESS_WORKFLOW_ROOT=C:\Momi-Animation\workflow
CREDIT_TRACKER_URLS=http://127.0.0.1:8188
```

The frontend calls only this backend; RunPod and Comfy API keys stay server-side.

Large browser uploads are streamed to `POST /api/media/upload` before job creation, and `/api/jobs` now receives media URLs instead of base64 media. Keep `JSON_BODY_LIMIT` low, such as `5mb`, and tune `MEDIA_UPLOAD_MAX_BYTES` deliberately for the largest input files you want to allow.

For large image/video inputs, set `RUNPOD_INPUT_BASE_URL` to a public HTTPS URL for this backend, such as a production domain or Cloudflare/ngrok tunnel. The backend will give RunPod short-lived signed download links to the original files instead of embedding base64 media in the JSON request, avoiding RunPod's 20MiB body limit without recompressing or resizing the images.

When `RUNPOD_INPUT_BASE_URL` is not configured, oversized image inputs are automatically resized and re-encoded before inline JSON submission so the request stays below RunPod's limit. This fallback can reduce image quality; set `RUNPOD_INLINE_IMAGE_AUTO_COMPRESS=false` to restore strict failures, or tune `RUNPOD_INLINE_IMAGE_MAX_DIMENSION` and `RUNPOD_INLINE_IMAGE_MIN_QUALITY`.

By default, RunPod mode scans `SERVERLESS_WORKFLOW_ROOT` for clean serverless workflow JSON files. Local Comfy development scans the legacy Comfy custom-node workflow folders unless `WORKFLOW_ROOTS` is explicitly set.

Serverless credit usage is stored on each job and, when a local Credit Tracker is reachable, mirrored to `/credit-tracker/api/ingest-rows`. If `CREDIT_TRACKER_URLS` is not set, the backend tries `http://127.0.0.1:8188` first and then the configured Comfy pool servers.

## Autorestart

Build the backend, then run it through PM2 using `backend/ecosystem.config.cjs`:

```powershell
pnpm --filter momi-animation-backend build
pm2 start backend\ecosystem.config.cjs
pm2 save
```

The PM2 config keeps one backend instance, restarts after crashes, and restarts on high RSS memory. Use one instance unless the queue is moved to a database-backed worker lock.

## Local ComfyUI Development

The legacy local ComfyUI pool path is available only when explicitly enabled:

```text
GENERATION_BACKEND=local_comfy
```

In that mode, the backend checks the configured ComfyUI pool with `GET /system_stats`, defaulting to ports `8201` through `8220`. It uses the first idle server and queues jobs in `backend/data/jobs.json`.

## RunPod Prompt Tools

The image-description prompt helper calls RunPod through the backend route:

```text
POST /api/prompt/describe-image
```

Configure the backend process with the RunPod variables above. If this helper uses a different endpoint than generation, split it before deploying.

The frontend never calls RunPod directly, so the API key stays server-side.

## Workflow Mappings

Models are scanned from the Brick workflow example folders. Automatic input detection handles common `prompt`, `image`, `width`, `height`, `video`, and `project_name` fields. For workflows with custom node IDs, fill `backend/config/workflow-mappings.json`.
