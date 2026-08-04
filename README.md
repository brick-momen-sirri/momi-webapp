# Momi Animation

Internal AI generation manager for Brick Visual. Artists pick a model, attach
reference images or video, and submit a render; the backend maps that to a
ComfyUI workflow, dispatches it to a RunPod serverless worker, and files the
result into the project folder structure on this host.

## How it fits together

```
browser  ->  Vite dev server :8190  ->  /api proxy  ->  Express backend :3333  ->  RunPod serverless ComfyUI
                (React 19, src/)                          (backend/src/)              (workflow/*.json)
                                                                |
                                                          SQLite stores
                                                     (jobs, app state, media index)
```

Two things about this shape are worth knowing before changing anything:

- **The frontend is served by the Vite dev server, not a build.** Edits under
  `src/` are live on reload; there is no frontend deploy step. `pnpm build`
  exists to type-check and to prove the app still compiles (CI runs it).
- **The browser never talks to RunPod.** All provider API keys stay in the
  backend process environment. The frontend's only origin is this backend.

Production on this host runs the split topology under pm2: one `momi-dispatcher`
fork owning job dispatch, plus clustered `momi-api` workers serving HTTP. See
[backend/docs/web-worker-split.md](backend/docs/web-worker-split.md).

## Layout

| Path              | What's in it                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`            | React frontend. `App.tsx` holds most app state; `services/backendApi.ts` is the only place that talks to the API.                            |
| `backend/src/`    | Express backend. `index.ts` registers the routes, `jobQueue.ts` owns the job lifecycle, `workflowService.ts` maps models onto workflow JSON. |
| `workflow/`       | ComfyUI workflow JSON, grouped by task (`i2v`, `flf2v`, `image_editing`, `prompt_generation`). Adding a file here adds a model.              |
| `backend/config/` | `workflow-mappings.json`, for workflows whose node IDs cannot be auto-detected.                                                              |
| `backend/docs/`   | Runbooks: DR, topology split, load test, singleton audit.                                                                                    |
| `scripts/`        | Windows log-on autostart for the app and the local Credit Portal ComfyUI.                                                                    |

## Prerequisites

- **Node 24**, pinned by `.nvmrc` and `engines`. Not optional: `better-sqlite3`
  is a native module built for that ABI, and a mismatch fails at startup with
  `ERR_DLOPEN_FAILED`. After any Node major change, run
  `pnpm rebuild better-sqlite3`.
- **pnpm** via corepack (`corepack enable`); the version is pinned by
  `packageManager`.

On this host Node is **not** on the global PATH — it lives in the Codex runtime
directory that `scripts/start-on-login.ps1` and `run_webapp_8190.bat` prepend.
Prepend the same directory before running pnpm by hand.

## Running it

Everything at once, in two console windows (what most people want):

```bash
run_webapp_8190.bat
```

Or the two halves separately:

```bash
pnpm --filter momi-animation-backend dev
```

```bash
pnpm dev
```

Frontend on <http://127.0.0.1:8190>, backend on <http://127.0.0.1:3333>.

## Configuration

All backend configuration is environment variables, read once at startup in
[backend/src/config.ts](backend/src/config.ts). **[.env.example](.env.example) is
the reference** — every variable is listed there with the reasoning behind its
default. Copy it to `.env` and fill in the RunPod and Comfy keys.

Secrets are never committed: `.env`, `backend/data/`, and all logs are
gitignored. The Azure backup SAS URL and provider API keys are set in the
process environment on the host only.

Session tokens travel in the `Authorization` header or the `momi_session`
cookie, never in a URL. Media URLs — which `<img>` and `<video>` load directly,
and so cannot attach a header to — carry a separate short-lived token that only
works on the media read routes; see
[mediaAccessToken.ts](backend/src/mediaAccessToken.ts). If you add a route that a
browser element loads directly, add it to the allowlist there rather than
widening what the session token accepts.

## Tests

```bash
pnpm --filter momi-animation-backend run test
```

```bash
pnpm --filter momi-animation-backend exec tsc --noEmit
```

The backend suite is ~270 tests, including integration tests for the parts that
are hard to reason about: dispatcher failover and lease handoff, SQLite backup
and restore drills, config-split guards. New backend modules are expected to
land with a matching `*.test.ts`, registered in the `test` script in
`backend/package.json`.

The frontend has no tests yet. That is the largest known gap in this repo.

## Lint and formatting

```bash
pnpm run lint
```

```bash
pnpm run format
```

ESLint is configured in [eslint.config.js](eslint.config.js), which explains why
each relaxed rule is relaxed. It is deliberately set at the non-type-aware tier:
`tsc --noEmit` already covers most of what the type-aware rules would add, and a
first linter that reports hundreds of findings is a linter everyone learns to
ignore.

**Errors must be zero. Warnings are a ratchet.** `pnpm run lint` passes
`--max-warnings` pinned to the backlog that existed when linting was introduced,
so any _new_ warning fails CI while the existing ones get paid down deliberately.
Lower that number as the backlog shrinks; never raise it. The backlog is almost
entirely `no-explicit-any` at provider boundaries (Comfy workflow JSON, RunPod
responses) plus effects that set state synchronously.

Prettier owns formatting; `printWidth` is 130 because that is roughly the
99th-percentile line length this code was already written at. The repo-wide
adoption commit is listed in `.git-blame-ignore-revs` — run
`git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame`
skips it.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the format check,
lint, the backend type-check, the backend suite, and the frontend build on every
push and PR.

## Deploying

Backend changes need a build and a pm2 reload; frontend changes need neither.
Deploy the backend **first** when a change spans both — the running frontend
tolerates a newer API, not an older one.

```bash
pnpm --filter momi-animation-backend build
```

Then reload through pm2 using `backend/ecosystem.config.cjs`. The topology flip,
rollback, and shared-state migration sequences are all in
[backend/README.md](backend/README.md#autorestart) — follow them rather than
improvising, because pm2 does not prune app names dropped from a changed
ecosystem file.

Run the topology gate before a deploy that touches dispatch. It uses a local
mock and temporary state, so it spends no RunPod credits and touches no
production data:

```bash
pnpm --filter momi-animation-backend run test:topology
```

## Operating it

A self-contained dashboard (queue depth, RunPod capacity, process memory, disk
headroom, recent alerts, backup freshness) is served by the app itself:

```text
http://127.0.0.1:3333/ops-dashboard
```

Prometheus text metrics are at `/metrics`. Both, along with `/api/health`,
`/api/ops-config`, `/api/alerts/recent` and `/api/backup-status`, sit outside
session auth — a scraper has no session — so they are guarded separately:
loopback callers are trusted, and anything else must present `OPS_ACCESS_TOKEN`.
By default that means the ops surface is local-only. To open the dashboard from
another machine, set the token and append `?token=...` to the URL.

Disaster recovery, including the restore drill, is in
[backend/docs/sqlite-dr-runbook.md](backend/docs/sqlite-dr-runbook.md).

## Conventions

- Keep ad-hoc process logs out of the repo root. Redirect to a path outside the
  working tree, or use `pm2 logs` — pm2 already captures backend output.
- Backend modules get a comment at the top explaining _why_ they exist, not what
  they do. Match that when adding one.
- `MISSING_DATA_REPORT.md` and `PROJECT_MEDIA_SCAN_REPORT.md` are point-in-time
  audits from early development, kept for provenance. They are not current
  documentation.
