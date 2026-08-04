# Architecture improvement plan

Last updated: 2026-08-04

This document tracks the production-readiness pass requested for the Momi Animation repository. The guiding constraint is behavioral compatibility: API contracts, credit accounting, job ordering and submission semantics, media paths, authentication, persisted data, failover, recovery, cancellation, archive, and backup behavior must remain unchanged.

## Baseline

Environment: Node 24.14.0, pnpm 11.9.0, TypeScript 5.9.3, Vite 7.3.6, Vitest 4.1.10.

| Gate                                 | Baseline result                                                |
| ------------------------------------ | -------------------------------------------------------------- |
| ESLint (`eslint . --max-warnings 0`) | Passed, zero warnings                                          |
| TypeScript (`tsc -b`)                | Passed                                                         |
| Frontend tests                       | 12 files, 151 passed, 0 skipped                                |
| Backend tests                        | 66 files, 414 passed, 0 skipped                                |
| Frontend production build            | Passed; main JS 508.80 kB (148.68 kB gzip), chunk-size warning |
| Backend build                        | Passed                                                         |
| Frontend coverage                    | Not configured at baseline                                     |
| Backend coverage                     | Not configured at baseline                                     |

No baseline command submitted a generation job or accessed production data. Integration tests use temporary stores and stubbed network calls.

## Responsibility maps

### Frontend application shell

Current `src/App.tsx` responsibilities:

| Domain                   | State/effects/handlers                                                                       | Intended owner                      |
| ------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------- |
| Authentication and users | session restoration, profile/password/admin-user actions, pinned project IDs                 | authentication hook                 |
| Workspace loading/status | models, projects, jobs, credits, runtime, Comfy and pod status, polling                      | workspace-data hook                 |
| Generation form          | model/workflow, resolution, duration, prompt, media, save number, image count, crop behavior | generation-settings hook/reducer    |
| Job submission           | validation, media upload, request creation, optimistic feed update                           | submission hook/service             |
| Job feed actions         | pagination, retry, move, archive/restore/delete, favorites, downloads, reuse                 | job-action hooks plus media utility |
| Projects/folders         | selection, create/update, folder mutation and confirmation                                   | project-action hook                 |
| UI state                 | theme, toasts, confirmation and download modals                                              | focused UI hooks/components         |
| Derived values           | selected model/project, credit summaries, input requirements, disabled reason                | pure selectors                      |
| Persistence              | generation settings, theme, favorites                                                        | storage utilities/hooks             |

Derived values will not be copied into new state. Polling must retain visibility gating and cleanup, and stale account/project responses must not overwrite a newer selection.

### Credit dashboard

`src/components/CreditUsageDashboard.tsx` contains modal state, range fetching, filters and sorting, chart aggregation, anomaly mapping, CSV export, formatting, tables, charts, and detail views. Pure calculation/filter/export functions will move to tested utilities; data loading will move to a hook; visual sections will be split by feature.

### Frontend API client

`src/services/backendApi.ts` currently contains transport, token and media-token lifecycle, DTOs, mappers, and auth/project/job/media/credit/runtime endpoints. The target is one shared transport and domain modules, with an index facade as the supported import surface.

### Backend queue dependency graph

```text
HTTP job routes
  -> jobQueue public facade
      -> repository/cache (JSON or SQLite, row-level merge)
      -> dispatcher lease (exclusive owner, heartbeat, takeover)
      -> lifecycle/dispatcher (claim, execute, settle)
          -> local Comfy or RunPod adapters
          -> credit accounting and tracker sync
          -> result persistence and media index invalidation
      -> cancellation
      -> archive/restore/delete and result moves
      -> remote-result recovery/media externalization
```

Critical invariants:

- A paid RunPod request is never duplicated after acknowledgment; `runpodJobId` is persisted before polling/resume.
- SQL claim plus dispatcher lease enforce the global concurrency cap and queue ordering.
- Lease loss prevents the stale dispatcher from claiming or finalizing ownership-sensitive work.
- Cancellation remains API-owned until the dispatcher settles it.
- Cache merging preserves in-flight object identity and API-owned fields.
- Existing SQLite and JSON job/archive formats remain readable without migration changes.
- Remote result recovery only externalizes completed remote URLs and never invents duplicate results.
- Archive and permanent-delete operations cannot remove live work.

## Phases and checklist

### 1. Frontend architecture

- [x] Replace production mock-record initial state with explicit empty defaults and a real model catalog.
- [x] Add characterization tests for startup, restoration, submission/validation, queue/result/error states, filters/credits, and unavailable/empty/loading states; existing panel/feed tests retain selection, favorite, pin, and media coverage.
- [x] Extract storage, selectors, generation, media, notification, authentication, workspace polling, project, and job-action responsibilities.
- [x] Make `App.tsx` a readable 492-line composition shell with focused props (down from 2,287 lines).
- [x] Verify frontend tests after every extraction.

Risk controls: preserve existing public component props and backend request payloads; add tests before changing submission and restoration logic; keep polling interval and visibility behavior; use cancellation/staleness guards for async effects.

### 2. Credit dashboard

- [x] Extract data-loading hook with stale-response protection.
- [x] Extract pure grouping, totals, date/filter/sort, comparison, malformed/duplicate/zero-record handling.
- [x] Separate the data/state layer from the existing focused summary, chart, filter, table, export, and state-view components.
- [x] Add focused utility and observable component tests.

Risk controls: snapshot/DOM assertions for labels and totals; no displayed-value changes without a verified bug.

### 3. API client

- [x] Create shared client with base URL, auth headers, JSON/error normalization, timeout/cancellation, and upload support.
- [x] Split auth, projects, jobs, media, credits, runtime/servers, and shared DTO mapping.
- [x] Replace the oversized implementation with a stable facade over the domain index.
- [x] Add shared transport network/error/timeout tests.

Risk controls: preserve function names, return shapes, URL construction, credentials, media-token behavior, and request payloads.

### 4. Production frontend serving

- [x] Build Vite assets before production start.
- [x] Add dedicated static gateway on port 8190, with `/api` proxy to the loopback backend.
- [x] Preserve blocked ops paths, media routes, SPA fallback, LAN binding, and reverse-proxy compatibility.
- [x] Add immutable caching for hashed assets and no-cache for `index.html`.
- [x] Add security headers and document compression/reverse-proxy handling.
- [x] Update PM2, scripts, environment docs, health behavior, deployment, and rollback.
- [x] Test static files, SPA fallback, cache/security headers, and blocked/proxied routes.

Risk controls: operational endpoints remain inaccessible through the public gateway; API stays loopback-bound; PM2 backend/dispatcher topology remains unchanged.

### 5. Backend queue decomposition

- [x] Preserve the `jobQueue.ts` public interface.
- [x] Extract media externalization, remote-media classification, and RunPod input naming.
- [x] Extract stable SQLite reads and debounced whole-store persistence boundaries.
- [x] Extract dispatcher lease coordination.
- [x] Extract remote-result recovery; retain cancellation/archive/claim-settle together where their atomic merge and in-flight identity are coupled.
- [x] Use existing characterization coverage plus focused pure-module tests before sensitive moves.
- [x] Run topology, handoff, failover, recovery, cancellation, archive, and restart tests after each move.

Risk controls: incremental extraction only; no persisted-format or public-interface changes; existing lease/failover integration tests remain mandatory.

### 6. Coverage and discovery

- [x] Add frontend V8 coverage with terminal, JSON, LCOV, and HTML output.
- [x] Add backend V8 coverage with terminal, JSON/LCOV, and HTML output.
- [x] Record baseline by major feature, add critical-path tests, and set realistic enforceable thresholds.
- [x] Replace the manually maintained backend test list with cross-platform discovery.
- [x] Compare discovery against all 66 baseline files and add a discovery guard.
- [x] Add coverage commands/gates and report artifacts to CI.

Risk controls: do not exclude difficult production modules; thresholds follow measured results rather than a vanity target.

### 7. Hygiene and performance

- [x] Remove render-time `console.debug` and audit accidental diagnostics.
- [x] Classify the two root reports as point-in-time audit artifacts retained for provenance.
- [x] Remove production dependency on `mockData.ts`; use explicit empty defaults and test fixtures.
- [x] Audit polling cleanup, request cancellation/staleness, duplicate fetch/update behavior, expensive filtering/sorting, and retained media state.
- [x] Add regression tests for stale credit-dashboard responses and duplicate usage records.

### 8. Documentation and final verification

- [x] Document frontend state ownership, API modules, queue modules, dev/production serving, PM2, coverage, discovery, deployment, rollback, invariants, and failure modes.
- [x] Document submission, dispatch, worker/media, result-display, auth/media-token, backup/restore, and lease-handoff flows.
- [x] Run every requested quality and operational gate without production data, provider calls, or generation credits.
- [x] Record final coverage, test totals, build sizes, performance changes, bugs, risks, and reassessment below.

## Change log and verification

This section will be updated after each phase with files, risks, tests, and exact results.

| Phase                 | Status   | Files/tests/result                                                                                                       |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| Baseline              | Complete | All existing gates green; 151 frontend and 414 backend tests                                                             |
| Frontend architecture | Complete | `App.tsx` 2,287 → 492 lines; domain hooks/utilities added; 172 frontend tests pass                                       |
| Credit dashboard      | Complete | 1,101 → 839 lines; stale-safe loader and tested pure aggregation/filter/export utilities; duplicate-count bug fixed      |
| API client            | Complete | 1,136-line implementation replaced by shared transport plus nine domain modules and stable facade                        |
| Production serving    | Complete | Built `dist/` served by tested `momi-web`; caching, compression, security headers, SPA fallback, ops blocking, API proxy |
| Queue decomposition   | Complete | 2,290 → 1,874-line lifecycle core plus seven focused modules; public API/data formats unchanged                          |
| Coverage/discovery    | Complete | Frontend 35.80/36.13/35.89/37.57; backend 64.70/72.77/75.28/64.70; gated in CI; 68 files discovered                      |
| Hygiene/performance   | Complete | Debug render log and mock startup removed; stale response and toast timer cleanup covered                                |
| Final verification    | Complete | Lint/type/format, 590 total tests, both coverage gates, production/backend builds, static/auth/media/topology/DR tests   |

## Final verification results

- ESLint: passed with zero warnings and zero errors.
- TypeScript: `tsc -b` passed.
- Frontend: 17 files, 172 tests passed; no skipped tests.
- Backend: 68 discovered files, 418 tests passed; no skipped tests.
- Coverage gates: passed with terminal, JSON, LCOV, and HTML output.
- Production build: passed. Assets: HTML 0.87 kB, CSS 47.24 kB
  (9.48 kB gzip), JavaScript 512.40 kB (150.01 kB gzip). The pre-existing
  Rollup 500 kB advisory remains and is tracked as non-blocking code-splitting debt.
- Backend build and production static-gateway tests: passed.
- Authentication/session, media-token authorization, topology, dispatcher poll,
  lease takeover/handoff, orphan normalization, cancellation, archive/delete,
  SQLite migration/restart, backup, and restore-drill coverage all ran in the
  discovered backend suite.
- Safety: tests used temporary stores and mocked/local HTTP workers. No production
  data was read or written, no real generation was submitted, and no credits were consumed.

## File inventory

Significantly changed or removed:

- Frontend shell/UI: `src/App.tsx`, `src/components/AppFeedback.tsx`,
  `src/components/CreditUsageDashboard.tsx`, `src/components/JobFeed.tsx`.
- API: `src/services/backendApi.ts` (now the stable four-line facade).
- Backend/runtime: `backend/src/jobQueue.ts`, `backend/ecosystem.config.cjs`,
  `backend/package.json`.
- Configuration/CI/docs: `.env.example`, `.github/workflows/ci.yml`,
  `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `README.md`,
  `backend/README.md`.
- Removed: `src/data/mockData.ts` and the unused `src/utils/localAuth.ts`.

Added frontend modules:

- `src/data/modelCatalog.ts`, `src/data/productionDefaults.ts` and its test.
- `src/features/auth/useAuthentication.ts`.
- `src/features/credits/creditUsageDashboardUtils.ts` and test;
  `useCreditDashboard.ts` and race tests.
- `src/features/generation/generationUtils.ts`, `useGenerationForm.ts`.
- `src/features/jobs/jobReuse.ts`, `resultMedia.ts`, `useJobActions.ts`,
  `useJobSubmission.ts` and validation/submission tests.
- `src/features/notifications/useNotifications.ts`.
- `src/features/preferences/appPreferences.ts`, `useTheme.ts`.
- `src/features/projects/useProjectActions.ts`.
- `src/features/workspace/useWorkspaceData.ts`, `workspaceUtils.ts`.
- `src/services/api/`: `client`, `authToken`, `mediaAccess`, `types`,
  `mappers`, the auth/project/job/model/credit/runtime/media domain clients,
  `index.ts`, and shared-client tests.

Added backend/runtime modules:

- `backend/src/frontendGateway.ts`, `frontendServer.ts`, and gateway tests.
- `backend/src/jobQueue/`: `dispatcherLease`, `jobPersistence`,
  `mediaExternalization`, `remoteMedia`, `remoteResultRecovery`,
  `runpodInputNaming`, `storeReads`, and `index.ts`.
- `backend/scripts/testDiscovery.mjs`, `runBackendTests.mjs`, and
  `backend/src/testDiscovery.test.ts`.
- `docs/architecture.md` and this tracked plan.

## Bugs and performance findings

- Fixed duplicate credit-dashboard records being counted more than once.
- Prevented an older credit-range response or error from overwriting a newer selection.
- Notification timers are now cleared on unmount, preventing late state updates.
- Workspace polling still pauses in hidden tabs, cleans up its interval, uses the
  combined snapshot endpoint for frequent small values, and refreshes projects/users
  only every third tick.
- Production now serves minified, compressed assets with immutable hashed-asset
  caching instead of compiling and serving through Vite on each host request.

## Follow-up pass (post-review)

A second review flagged four items the first pass left. All four are now closed;
this section records what changed and how each was verified.

### Coverage thresholds were too tight to survive

The gates sat 0.68–0.71 points above measured coverage. Re-measuring produced
figures 0.02–0.06 below the recorded ones, so ordinary run-to-run drift was already
the same size as the margin — the gate would have red-built CI on unrelated changes.
Thresholds now sit ~3 points below baseline (frontend 32/33/32/34, backend
61/69/72/61), with the reasoning recorded in `vitest.config.ts` and the
`comment:coverage` field of `backend/package.json` so nobody re-tightens them by
reflex. They are a regression ratchet, not a target.

### The refactored app had never been run

Every gate was green but nothing had loaded the app. The production gateway was
started on port **8191** against `dist/`, with `FRONTEND_API_TARGET` pointed at a
dead port, so no request could reach the real backend and no production data or
credits were touched. Verified in a real browser:

- The built bundle mounts; React renders the sign-in screen with **zero console
  output** — meaning the extracted auth hook's failure path (session probe fails →
  token cleared → `AuthScreen`) behaves as designed.
- Clicking the theme toggle set `data-theme`, `color-scheme`, and persisted
  `momi_theme_v1`, exercising `useTheme` + `appPreferences` end to end.
- A submit against the dead API surfaced `Internal API unavailable: connect
ECONNREFUSED`, confirming gateway → api-client → UI error propagation.
- Headers confirmed by request: `no-cache` on the shell, `public, max-age=31536000,
immutable` on hashed assets, gzip active, full security header set with a real
  CSP, SPA fallback 200 on a deep path, all four ops paths 404 without being
  proxied, and normal `/api` paths proxied (502 from the dead target).

### Queue decomposition: provider input materialization extracted

`jobQueue.ts` 1,874 → **1,593** lines. The whole "turn stored media into provider
inputs" responsibility moved to `jobQueue/providerInputs.ts` (304 lines): the RunPod
signed-URL/inline-base64 path, the local ComfyUI upload path, the media path
allowlist, size assertions, and MIME/extension mapping.

The cut was chosen because these 20 functions touch **none** of the module's mutable
state (`jobs`, `dispatching`, `activeRunpodJobs`, lease state) — they take a job or a
path and return a descriptor. Only 5 are called from outside, so the extraction
narrowed a 20-function surface to 5. Risk was controlled by moving code verbatim
(no logic edits), then letting the compiler and linter prove the boundary: 20 imports
became unused, confirming nothing left behind still depended on the moved code.
Verified by the full backend suite — 418/418 before, all still passing after.

This is a real reduction but not the whole job: claim/execute/settle, the row-level
cancellation merge, and archive membership still share mutable in-flight identity.
See Remaining debt.

### The media path allowlist had no tests

`localMediaFilePathFromUrl` is the only barrier between a crafted
`/api/media?path=` and an arbitrary file read from the dispatcher process, and it had
zero direct coverage — so moving it across a module boundary was riskier than the
diff suggested. `jobQueue/providerInputs.test.ts` now pins it with 7 tests: each
allowed root accepted, outside-root paths refused, traversal that climbs out of a
root refused, non-media routes refused, empty/malformed input refused, and absolute
backend URLs treated like relative ones.

The last test documents a **known gap** rather than silently fixing it: the guard
compares with `startsWith()` and no trailing separator, so a sibling directory whose
name merely begins with an allowed root (`..._uploads_evil`) is also accepted.
Exploiting it needs both influence over `?path=` and an existing file, so it is
hardening rather than an open hole — but it is a security behavior change and should
land on its own alongside a review of `/api/media`'s LAN exposure. It is listed in
Remaining debt.

### Repository hygiene

The two point-in-time audits moved out of the repo root into `docs/history/`.
`MISSING_DATA_REPORT.md` → `comfyui-data-gap-analysis.md`: kept deliberately, since
the field-by-field gap analysis is the rationale for why job metadata has the shape
it does. `PROJECT_MEDIA_SCAN_REPORT.md` → `project-media-scan-2026-07-02.md`: a dated
scanner snapshot that names client projects, so the README now says not to refresh it
in place or add new scans there. Note that removing the file would not scrub those
names from git history; doing that needs a history rewrite and is a separate call.

### Follow-up verification

| Gate                              | Result                                                             |
| --------------------------------- | ------------------------------------------------------------------ |
| ESLint `--max-warnings 0`         | pass                                                               |
| `tsc -b` / backend `tsc --noEmit` | pass                                                               |
| Prettier                          | pass                                                               |
| Frontend tests                    | 172 passed / 17 files                                              |
| Backend tests                     | **425 passed / 69 files** (was 418/68; +7 from the new guard test) |
| Frontend coverage                 | 35.80 / 36.13 / 35.89 / 37.57 — gate 32/33/32/34                   |
| Backend coverage                  | 64.83 / 72.79 / 75.49 / 64.83 — gate 61/69/72/61                   |
| Frontend build                    | pass (512.46 kB, 150.00 kB gzip)                                   |
| Backend build                     | pass                                                               |
| Browser smoke test                | pass (isolated port, dead API target)                              |

The new nested test file was picked up by recursive discovery with no manifest edit —
which incidentally proves the discovery replacement works for nested paths.

No pm2 process was restarted, no production data was read or written, no generation
job was submitted, and no credits were consumed. Production remained live on
8190/3333/3334 throughout, on unchanged PIDs.

## Remaining debt

- The queue lifecycle core is still 1,593 lines because claim/execute/settle,
  row-level cancellation merge, and archive membership share mutable in-flight
  identity. A future repository-object extraction should precede splitting those
  transitions; the current topology tests are the required safety net.
- The media path allowlist accepts sibling directories that share an allowed root's
  string prefix (pinned by the final test in `jobQueue/providerInputs.test.ts`). Fix
  with a separator-aware comparison plus an equality check for the root itself, in a
  change scoped to that security boundary.
- `CreditUsageDashboard.tsx` still contains its visual subcomponents in one file.
  Data loading and all calculations are separated, so moving JSX sections is now
  low-risk organizational work rather than a behavioral refactor.
- The main frontend bundle remains just above Rollup's 500 kB advisory. Lazy-load
  the analytics modal or admin surfaces in a dedicated performance change with a
  loading-state test.
- Raise global coverage thresholds incrementally; highest-risk targets are the
  remaining queue lifecycle branches and the newly extracted workspace/job-action hooks.
