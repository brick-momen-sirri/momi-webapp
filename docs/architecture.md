# Momi Animation architecture

## Runtime topology

Development uses Vite on `:8190` with HMR and proxies `/api` to the Express API
on loopback `:3333`. Production never starts Vite. PM2 runs `momi-web`, which
serves the built `dist/` bundle, applies compression/cache/security headers, and
streams allowed `/api` traffic to the loopback API. Operational endpoints are
deliberately blocked at this LAN-facing gateway.

```text
browser/LAN -> momi-web :8190 -> static dist/ or allowed /api proxy
                                      |
                                      v
                               momi-api :3333 (loopback)
                                      |
                         SQLite stores + signed media paths
                                      |
                        momi-dispatcher (split topology)
                                      |
                       RunPod or local Comfy development
```

The monolith topology combines API and dispatcher responsibilities in
`momi-backend`; `momi-web` remains a separate process in both modes.

## Frontend ownership

- `App.tsx` is the composition shell and owns only cross-feature selection and
  modal state.
- `features/auth/useAuthentication.ts` owns session restoration, account and
  user administration, password/profile actions, and pinned projects.
- `features/workspace/useWorkspaceData.ts` owns initial workspace loading,
  pagination, visibility-aware polling, credits, runtime, pod and Comfy status.
- `features/generation/useGenerationForm.ts` owns workflow/model fields, prompt,
  media inputs, validation, derived cost, and settings persistence.
- `features/jobs/useJobSubmission.ts` owns validation, upload, backend/local job
  creation, and feed/project counters.
- `features/jobs/useJobActions.ts` owns results, retry/move/archive/delete,
  favorites, downloads, and optimistic rollback.
- `features/projects/useProjectActions.ts` owns project/folder mutations.
- `features/credits/useCreditDashboard.ts` owns range fetches and guards against
  stale responses; `creditUsageDashboardUtils.ts` owns tested calculations.
- `services/api/client.ts` is the only transport. Domain modules expose auth,
  project, job, media, credit, model, and runtime calls through `services/api/index.ts`.
  `services/backendApi.ts` is the intentionally stable public facade.

## Backend queue ownership

`backend/src/jobQueue.ts` retains lifecycle orchestration and its existing public
interface. Stable, separately testable responsibilities live under
`backend/src/jobQueue/`:

- `dispatcherLease.ts`: owner identity, acquire/renew/release, takeover state,
  and operator snapshot.
- `storeReads.ts`: stable SQLite snapshot and incremental-read loops.
- `remoteMedia.ts`: detection of completed results still using remote URLs.
- `remoteResultRecovery.ts`: bounded retry and atomic externalization of those
  results.
- `runpodInputNaming.ts`: collision-free workflow input names and extensions.
- `index.ts`: internal facade used by the public `jobQueue.ts` API.

The remaining lifecycle core is intentionally not mechanically scattered:
claim/execute/settle and persistence share in-flight object identity and
cancellation ownership. Further extraction should introduce a repository object
first and must keep the topology integration suite green.

## End-to-end flows

### User action to job submission

```text
form fields/media -> useGenerationForm validation -> useJobSubmission
  -> stream media uploads -> POST /api/jobs -> optimistic feed/counter update
```

No job is posted until a concrete project is selected and model-specific input,
prompt, credit, resolution, and duration rules pass.

### Submission to dispatcher

```text
POST /api/jobs -> externalize input data -> persist queued row
  -> SQL claim under global concurrency cap -> sending/running transition
```

In split mode only the process holding the SQLite dispatcher lease may claim.
The RunPod job ID is persisted before polling so a successor resumes rather than
submitting the paid request again.

### Worker to saved media

```text
workflow + named inputs -> RunPod/Comfy -> select result artifacts
  -> atomic local write -> project manifest/index -> local /api/media URL
```

If a remote artifact cannot be copied immediately, recovery retries it with a
bounded per-process count while the signed URL is still usable.

### Saved result to browser

```text
poll /api/jobs -> mapped Job -> JobFeed -> scoped media token
  -> authorized /api/media read/range request -> image/video element
```

### Authentication and media tokens

Session credentials travel only in an Authorization header or HttpOnly cookie.
Browser media elements cannot attach that header, so the frontend obtains a
short-lived token restricted to media-read routes. A media token is never a
general session token and must not authorize JSON APIs.

### Backup and restore

```text
dispatcher/monolith timer -> SQLite online backup (includes WAL)
  -> rotate local snapshots -> optional Azure upload -> status + alert
  -> restore drill opens copied DB and verifies rows
```

Follow `backend/docs/sqlite-dr-runbook.md`; never restore over a running store.

### Lease handoff and recovery

```text
owner heartbeat stops -> lease TTL/dead same-host owner check -> successor acquire
  -> keep recent acknowledged jobs inside cap -> resume by runpodJobId
  -> normalize only safe orphaned pre-acknowledgement work -> continue claims
```

## Invariants

- Queue ordering and the SQL-counted global concurrency cap are stable.
- A stale lease owner cannot claim new work after handoff.
- Cancellation requests are API-owned until a dispatcher atomically settles them.
- Active jobs cannot be archived; permanent deletion affects archived rows only.
- In-flight object identity survives incremental cache refreshes.
- JSON and SQLite persisted formats, project paths, and media URLs remain compatible.
- Credit estimates/accounting sources are not interchangeable; fallback estimates
  are never reported as actual provider spend.
- LAN traffic reaches the static gateway, not the loopback API or operational routes.
- Production startup begins from API data and explicit empty arrays, never test fixtures.

## Quality gates

`pnpm run test:coverage` and
`pnpm --filter momi-animation-backend run test:coverage` emit terminal, JSON,
LCOV, and HTML reports. Backend tests are discovered recursively and
deterministically by `backend/scripts/testDiscovery.mjs`; fixtures/helpers/build
output are excluded and the guard fails if the known suite unexpectedly shrinks.
