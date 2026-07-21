# Momi Animation Backend

Node/Express backend for routing generation jobs to a RunPod serverless ComfyUI worker.

## Node version

Runs on **Node 24** in production (pm2), pinned via `.nvmrc` and `engines`.
`better-sqlite3` is a native module compiled for that ABI. If you switch Node
major versions (dev, CI, or the deploy host), rebuild it or the native binding
fails to load at startup (`ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION mismatch`):

```powershell
pnpm rebuild better-sqlite3
```

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
RUNPOD_SUBMISSION_MODE=async
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

The PM2 config defaults to the existing one-process monolith. The tested split
topology is available behind `MOMI_TOPOLOGY_SPLIT=true`; it starts one
`momi-dispatcher` fork on internal port 3334 and two clustered `momi-api`
workers on port 3333. The split config forces the shared SQLite stores,
row-level job writes, async RunPod submission, and disables process-local
balance-delta accounting.

Run the isolated topology gate before a deployment (it uses a local mock and
temporary state, so no RunPod credits or production data are touched):

```powershell
cd backend
pnpm test:topology
```

First back up the JSON stores, then migrate them while still running one
monolith. Keep `MOMI_SHARED_STATE=true` through the split and any topology-only
rollback so the current SQLite users, sessions, projects, and jobs remain the
source of truth:

```powershell
$env:MOMI_SHARED_STATE='true'
$env:MOMI_TOPOLOGY_SPLIT='false'
pm2 start backend\ecosystem.config.cjs --update-env
pm2 save
```

After validating the migrated monolith and rerunning the gate, flip topology:

```powershell
$env:MOMI_SHARED_STATE='true'
$env:MOMI_TOPOLOGY_SPLIT='true'
pm2 delete momi-backend
pm2 start backend\ecosystem.config.cjs --update-env
pm2 save
```

Rollback is explicit because PM2 does not prune app names omitted by a changed
ecosystem file:

```powershell
$env:MOMI_SHARED_STATE='true'
$env:MOMI_TOPOLOGY_SPLIT='false'
pm2 delete momi-api momi-dispatcher
pm2 start backend\ecosystem.config.cjs --update-env
pm2 save
```

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
