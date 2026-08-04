# Momi Animation

Internal AI generation manager for Brick Visual. Artists pick a model, attach
reference images or video, and submit a render; the backend maps that to a
ComfyUI workflow, dispatches it to a RunPod serverless worker, and files the
result into the project folder structure on this host.

## How it fits together

```
development: browser -> Vite/HMR :8190 -> /api proxy -> Express :3333
production:  browser -> momi-web :8190 -> /api proxy -> Express :3333 -> RunPod
                              |                              |
                         built dist/                    SQLite stores
```

Two things about this shape are worth knowing before changing anything:

- **Vite is development-only.** `pnpm dev` provides HMR and source maps. PM2
  production runs `momi-web`, a compressed static gateway for the built `dist/`
  assets; it proxies application APIs but blocks operational endpoints.
- **The browser never talks to RunPod.** All provider API keys stay in the
  backend process environment. The frontend's only origin is this backend.

Production on this host runs `momi-web` plus either the monolith or the split
topology (one `momi-dispatcher` and clustered `momi-api` workers). See
[backend/docs/web-worker-split.md](backend/docs/web-worker-split.md).

## Layout

| Path                     | What's in it                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`                   | React frontend. `App.tsx` composes feature hooks under `features/`; `services/api/` contains the shared transport and domain clients.                                                                                                                                                                                                    |
| `backend/src/`           | Express backend. `index.ts` is wiring and lifecycle only; `jobQueue.ts` orchestrates lifecycle around the focused modules in `jobQueue/`.                                                                                                                                                                                                |
| `backend/src/routes/`    | One module per route group, each exporting a Router. **Mount order in `index.ts` is a correctness constraint** — three routers sit above the session middleware (ops has its own guard, RunPod input links carry a signed token, sign-in cannot require a session) and the rest below it. Read the comments there before moving a mount. |
| `workflow/`              | ComfyUI workflow JSON, grouped by task (`i2v`, `flf2v`, `image_editing`, `prompt_generation`). Adding a file here adds a model.                                                                                                                                                                                                          |
| `backend/config/`        | `workflow-mappings.json`, for workflows whose node IDs cannot be auto-detected.                                                                                                                                                                                                                                                          |
| `docs/`, `backend/docs/` | Architecture and runbooks: serving, DR, topology split, load test, singleton audit.                                                                                                                                                                                                                                                      |
| `scripts/`               | Windows log-on autostart for the app and the local Credit Portal ComfyUI.                                                                                                                                                                                                                                                                |

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

## Running it in development

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

## Building and running production

```bash
pnpm run build:production
pnpm run start:production
```

The first command type-checks and creates the minified Vite bundle plus the
backend build. The second starts/reloads the PM2 topology from
`backend/ecosystem.config.cjs`. The LAN-facing health check is
`http://127.0.0.1:8190/healthz`; API health and operational dashboards remain
loopback-only on `:3333`.

`FRONTEND_HOST`, `FRONTEND_PORT`, `FRONTEND_DIST_PATH`, and
`FRONTEND_API_TARGET` are documented in `.env.example`. Do not point the gateway
at a remote or LAN API unless that exposure has been reviewed explicitly.

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

The backend suite includes integration tests for the parts that
are hard to reason about: dispatcher failover and lease handoff, SQLite backup
and restore drills, config-split guards. Tests are discovered recursively and
sorted by `backend/scripts/testDiscovery.mjs`; do not add paths to a manual list.
`pnpm --filter momi-animation-backend run test:list` shows the exact set.

### Frontend

```bash
pnpm run test
```

Vitest + React Testing Library in jsdom, configured in
[vitest.config.ts](vitest.config.ts) with jsdom shims in
[src/test/setup.ts](src/test/setup.ts) (IntersectionObserver, HTMLMediaElement
play/pause, scrollIntoView — none of which jsdom implements).

Coverage gates run the same suites and emit terminal, JSON, LCOV, and local HTML
reports:

```bash
pnpm run test:coverage
pnpm --filter momi-animation-backend run test:coverage
```

Reports are written to `coverage/frontend/` and
`backend/coverage/backend/`. Initial global thresholds deliberately sit just
below the measured baseline and should only move upward. CI publishes both
directories as one artifact.

When adding a test, prefer asserting the thing a user would notice over the
implementation detail that produces it. Two traps already caught here:

- **Verify a new test can fail.** Break the code it covers and confirm it goes
  red. Both suites here were mutation-checked that way; the `JobFeed` filter
  tests caught 5, 3, 1 and 1 failures against four separate broken predicates.
- **`{ exact: false }` in Testing Library is also case-insensitive.** A job
  prompted "my job" matched the scope dropdown's own "Scope: My jobs" option, so
  the assertions passed while checking nothing. Use case-sensitive matching and
  fixture text that cannot collide with the component's own labels.

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

**Errors and warnings must both be zero.** `pnpm run lint` uses
`--max-warnings 0`, so a new warning fails locally and in CI.

The 82 `no-explicit-any` warnings that made up most of the original backlog are
gone: they were all Comfy graph JSON, and they now use the named `ComfyNode` /
`ComfyGraph` / `ComfyPort` types in
[comfyGraph.ts](backend/src/comfyGraph.ts). Read the header there before
assuming that made the graph type-safe — it did not, and it says why. What it
did was turn 67 silent decisions into one explained one.

The warning backlog is now zero. Keep suppressions narrow and explain any
external-state effect that genuinely cannot follow the default hook rule.

Prettier owns formatting; `printWidth` is 130 because that is roughly the
99th-percentile line length this code was already written at. The repo-wide
adoption commit is listed in `.git-blame-ignore-revs` — run
`git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame`
skips it.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs formatting, lint,
type-checking, both coverage-gated suites, and the production frontend build.

## Deploying

Backend and frontend changes both require a production build and PM2 reload.
Deploy compatible backend routes first when a change spans both; the existing
built frontend should remain usable during that short transition.

```bash
pnpm run build:production
pnpm run start:production
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
- `docs/history/` holds point-in-time audits from early development, kept for
  provenance and not maintained as current documentation.
  [comfyui-data-gap-analysis.md](docs/history/comfyui-data-gap-analysis.md) is the
  field-by-field gap analysis that shaped the job metadata schema — still useful
  for understanding _why_ a field exists.
  [project-media-scan-2026-07-02.md](docs/history/project-media-scan-2026-07-02.md)
  is a dated scanner snapshot; the counts are long stale, and it names client
  projects, so do not refresh it in place or add new scans here.
