# Road to 9.5

This document tracks the safe, local-only improvement phase that began from the
9.3 assessment. It is intentionally operational: every item records the failure
mode, the tests that must pin behavior before implementation, verification, and
how to roll back the change.

## Safety baseline

- Branch: `refactor/architecture-pass`
- Starting commit: `18119079e02266498f75e52c86b44ab69c8724e0`
- Starting tree: clean
- Existing assessed commits, oldest first:
  1. `90611b8 Refactor architecture and replace the Vite dev server in production`
  2. `8c248a9 Test the five large frontend components`
  3. `7cd5000 Test the prompt API, job actions, and job reuse`
  4. `479530a Test the credit estimator and the project/result-media helpers`
  5. `2745f45 Test the auth service's JSON driver and the credit usage reconciler`
  6. `1811907 Test the HTTP route modules end to end`
- Starting quality gate: ESLint passed, TypeScript passed, 413 frontend tests
  passed, and 497 backend tests passed (910 total; zero skipped).
- Port 8190 at phase start: PID 34928, executable
  `C:\Users\momen.sirri\AppData\Local\Programs\nodejs-portable\node-v24.15.0-win-x64\node.exe`,
  command `node C:\Momi-Animation\node_modules\vite\bin\vite.js --host 0.0.0.0 --port 8190 --strictPort`,
  listening on `0.0.0.0:8190`.
- Safety boundary: do not stop/reload/reconfigure PID 34928, PM2, a production
  process, production data, cloud infrastructure, or paid providers. Do not
  submit a real generation job or consume credits. Gateway checks use an isolated
  local port and fake/local dependencies only.

## Prioritized checklist

### 1. Canonical media-path containment

- Current problem: the provider-input disk allowlist lowercases resolved paths
  and uses bare `startsWith`, so a sibling sharing an allowed root's prefix is
  accepted. Containment implementations are duplicated across media boundaries.
- Risk level: critical security hardening; a crafted stored media URL could make
  a dispatcher read a file from a similarly named sibling directory.
- Affected files: `backend/src/jobQueue/providerInputs.ts`, `backend/src/httpMedia.ts`,
  `backend/src/runpodInputUrlService.ts`, media-route and containment tests, plus
  any additional path boundary found by the audit.
- Proposed solution: one lexical, separator-aware canonical containment helper
  based on `resolve` + `relative`, with explicit Windows path semantics. Before
  opening an existing local media file, resolve filesystem links and re-check the
  real path against real allowed roots where practical.
- Tests required before changing it: direct child, deep child, root, prefix
  sibling, traversal, mixed/repeated separators, encoded and double-encoded
  traversal, outside absolute path, similar directory name, Windows case, drive
  mismatch, UNC, NUL, and a symlink/junction escape where supported.
- Implementation status: complete. Shared `pathContainment.ts` and
  `mediaPathPolicy.ts` now guard HTTP media, provider reads, RunPod tokens/downloads,
  Comfy pool scripts, and serverless workflow-path classification. Existing paths
  are realpathed immediately before read/stream/upload to stop link escapes.
- Verification results: direct/deep/root, prefix siblings, traversal, repeated and
  mixed separators, encoded/double-encoded inputs, outside absolutes, Windows
  case/drives, UNC paths, NUL, and a real junction escape pass. Legitimate HTTP,
  provider, thumbnail policy, and signed-RunPod suites pass. Full backend suite:
  502 passed, zero failed/skipped.
- Remaining risks: a filesystem entry can theoretically be swapped after realpath
  but before open (TOCTOU). Node's cross-platform stream APIs do not expose a
  portable open-beneath primitive; preventing that stronger attacker model would
  require handle-based OS-specific file opening.
- Rollback approach: revert the isolated containment commit; no data migration or
  persisted format change is involved.

### 2. Bounded `decodeImageBlob`

- Current problem: the HTML image fallback waits forever if neither `onload` nor
  `onerror` fires; handlers and object URLs are not cleaned on failure.
- Risk level: high frontend reliability and memory risk.
- Affected files: `src/services/promptApi.ts` and focused frontend tests.
- Proposed solution: configurable 10-second default deadline, abort support,
  single-settlement cleanup, late-event suppression, and deterministic object-URL
  revocation. The 10-second default is well above normal local Blob decoding but
  bounds browser/codec failure; tests override it with fake timers.
- Tests required before changing it: bitmap and HTML success, onerror, no event,
  timeout, event immediately before/after timeout, cleanup, multiple callbacks,
  and abort.
- Implementation status: complete. The decoder is isolated in
  `src/services/imageBlobDecoder.ts`, uses one deadline across bitmap and HTML
  fallbacks, accepts an AbortSignal and timeout override, attaches handlers before
  assigning `src`, settles once, and performs idempotent cleanup.
- Verification results: nine focused tests cover HTML success/error/no-event,
  timeout edges, late/duplicate callbacks, abort, bitmap success, and a bitmap
  resolving after timeout. The late bitmap is closed. Full frontend suite: 422
  passed, zero failed/skipped.
- Remaining risks: browsers do not offer cancellation of an in-progress
  `createImageBitmap`; the wrapper rejects at the deadline and closes any bitmap
  that completes later, but the browser may continue decoding internally briefly.
- Rollback approach: revert the isolated frontend defect commit.

### 3. Safe `POST /api/jobs` integration harness

- Current problem: existing HTTP integration coverage deliberately omits the job
  creation route because its production dependency graph can dispatch paid work.
- Risk level: critical business, authorization, and billing boundary.
- Affected files: `backend/src/routes/jobRoutes.ts`, a small submission seam or
  router factory, test-only adapters/fixtures, and route integration tests.
- Proposed solution: first map the actual dependency and transaction graph. Add
  narrow dependency injection around creation/dispatch so tests use isolated
  repositories, deterministic credits, temporary media, and a fail-closed fake
  provider whose network path throws immediately.
- Tests required before changing it: auth/ownership, validation matrix, successful
  observable state, idempotent retry, reservation/creation/queue/provider/database
  failures, exactly-once refund, cancellation race, and a network/provider tripwire.
- Implementation status: complete for the current production contract. The route
  now has a narrow injected submission port, fail-closed request/media validation,
  persistence-before-dispatch rollback, a controlled in-memory route harness, and
  a real API-role/SQLite integration test with an outbound-network tripwire. See
  `docs/POST_JOBS_SAFETY.md` for the dependency and capability map.
- Verification results: route tests cover successful owned creation, deterministic
  estimate/state, auth roles, malformed/invalid inputs, media ownership/type/size,
  provider options, persistence failure, and zero provider/network dispatch. The
  production router test observes the queued job in the real queue/store path.
- Remaining risks: the repository has no reservation ledger, insufficient-balance
  transaction, exactly-once refund, or idempotency key. Those guarantees remain
  explicitly unimplemented rather than simulated by a fake test. Provider and
  cancellation failures occur asynchronously after the 201 response and belong to
  lifecycle tests.
- Rollback approach: keep production defaults behind the compatibility export and
  revert the harness/submission commit; tests never use production configuration.

### 4. Job lifecycle core decomposition

- Current problem: `backend/src/jobQueue.ts` is about 1,593 lines and combines
  persisted lifecycle, claims, dispatch, cancellation merging, archive membership,
  settlement, recovery, snapshots, and mutable in-flight identity.
- Risk level: critical concurrency and credit-settlement risk.
- Affected files: `backend/src/jobQueue.ts`, `backend/src/jobQueue/*`, lifecycle
  documentation and characterization tests.
- Proposed solution: document actual states/invariants and public contracts first;
  then extract behavior-aligned modules behind a compatibility facade. Claim and
  execution identity must be explicit and stale-worker-testable, not another global.
- Tests required before changing it: competing/stale claims, cancellation/completion
  races, archive while active, worker/dispatcher restart, duplicate result and
  settlement, settlement retry, orphan recovery, snapshot restoration, and shutdown.
- Implementation status: complete. `jobQueue.ts` was reduced from about 1,593 to
  1,098 lines while preserving its public exports. Pure lifecycle transitions,
  immutable execution claims, queued-job construction, archive/media listing,
  and both provider executors now live in focused modules under `jobQueue/`.
- Verification results: 19 focused extraction tests cover claim identity,
  restart substates, cancel/complete ordering, idempotent settlement, orphan and
  archive rules, construction/listing, and local result de-duplication. The full
  backend suite passes 538 tests with zero failures or skips; backend TypeScript
  build is clean.
- Remaining risks: multi-process behavior may depend on persistence-driver atomicity;
  extraction cannot manufacture stronger guarantees without a schema/lease change.
- Rollback approach: small behavior-neutral extraction commits, preserved facade,
  no persisted-format change unless separately documented and authorized.

### 5. High-risk behavior coverage

- Current problem: `workflowService`, `mediaRoutes`, `providerInputs`, and
  `comfyPool` have important low-coverage branches.
- Risk level: high.
- Affected files: those modules and table-driven/fake-transport tests.
- Proposed solution: cover security and state transitions, introducing only narrow
  transport or clock seams where deterministic testing requires them.
- Tests required before changing it: the matrices in the phase request, prioritized
  by ownership, payment/provider inputs, timeouts, recovery, and stream behavior.
- Implementation status: complete for the repository's implemented behavior.
  Workflow discovery/input-name/snapshot/error behavior is characterized;
  provider materialization now runs against a local fake Comfy transport; media
  routes are exercised over a real isolated HTTP socket; and Comfy health/action
  decisions use injectable adapters without changing the production facade.
- Verification results: backend coverage moved from 75.08% lines / 74.45%
  branches / 83.31% functions to 78.80% / 74.40% / 87.55%. Sensitive module
  line coverage moved from 71.51% to 77.14% (`workflowService`), 18.85% to
  76.54% (`mediaRoutes`), 22.18% to 85.09% (`providerInputs`), and 20.15% to
  69.83% (`comfyPool`). The full backend suite passes 560 tests with zero skips.
  New media tests found and fixed an uploaded-input disclosure: uploaded paths
  were not mapped back to their project ACL, so an unrelated authenticated user
  who knew a path could read it.
- Remaining risks: workflow disabling and per-model provider selection are not
  repository capabilities, so no fake coverage claims are made for them. Comfy
  tests cover health transitions and command routing/time budgets but deliberately
  do not launch the real desktop scripts. Media abort/error plumbing still relies
  partly on the focused stream helper tests; local tests cannot reproduce every
  client disconnect and Windows file-lock timing.
- Rollback approach: tests and small seams land separately from behavior changes.

### 6. `CreditUsageDashboard` split and frontend async audit

- Current problem: the 839-line component colocates fetching, filters, grouping,
  calculation, presentation, and export behavior.
- Risk level: medium; totals/rounding regressions are the primary concern.
- Affected files: `src/components/CreditUsageDashboard.tsx`, new focused dashboard
  modules/selectors/hooks, and tests.
- Proposed solution: characterize totals first, extract pure selectors/types and
  focused sections, keep the top level as composition plus minimal UI state, and
  fix only demonstrated abort/object-URL/timer/request-identity issues.
- Tests required before changing it: project grouping, four-digit names, dates,
  Comfy and Project Dream totals, zero/missing/duplicate/invalid rows, empty/large
  data, stable sort, and four-decimal rounding.
- Implementation status: complete. The public component is now a 54-line facade;
  dialog/request control, dashboard composition/chart state, summary panels, and
  tabular presentation are separate modules under `components/credit-usage/`.
  Existing pure selectors remain in `features/credits/creditUsageDashboardUtils.ts`.
  The audit also fixed stable descending ties, bounded URL-image loading, stale
  upload completion/object-URL cleanup, transient message timers, and delayed
  Comfy-pool refresh timers after unmount.
- Verification results: selector tests now cover all presets, four-digit project
  names, 2,000-row top-five/Other aggregation, duplicate/invalid/zero data,
  four-decimal USD display, stable ascending/descending ties, and synchronous CSV
  object-URL revocation. Component/hook tests cover lazy fetching, stale responses,
  errors, Escape/body-scroll cleanup, upload teardown, image timeout/abort, and
  Comfy refresh teardown. The full frontend suite passes 439 tests with zero skips;
  TypeScript is clean.
- Remaining risks: dashboard requests use request identity to prevent stale state
  but do not pass a caller-owned AbortSignal through the API facade, so a closed
  dialog may leave transport work running until the shared client timeout. The
  result is discarded safely; end-to-end cancellation would require a broader API
  signature change. Very large recent-event payloads are still sorted client-side,
  although the expensive derived arrays are memoized by their real dependencies.
- Rollback approach: compatibility re-export and a sequence of extraction-only commits.

### 7. Isolated production-gateway verification and deployment runbook

- Current problem: the repository has a static gateway but port 8190 still serves
  Vite; production behavior has not been proven in situ.
- Risk level: high deployment readiness, but no production mutation is authorized.
- Affected files: gateway smoke tests and `docs/PRODUCTION_GATEWAY_DEPLOYMENT.md`.
- Proposed solution: build and start only on an isolated local port; automate cache,
  fallback, API/media boundary, headers, health, and shutdown checks; validate PM2
  syntax without reload; write exact approval-gated deploy/rollback commands.
- Tests required before changing it: build/backend builds plus automated HTTP and
  browser smoke coverage on the isolated port.
- Implementation status: complete for safe local work. Gateway cache/fallback
  behavior was corrected, request/cookie/CORS and ranged-media proxying expanded,
  strict port parsing and bounded graceful shutdown added, and the PM2 topology
  syntax characterized. `scripts/start-on-login.ps1` now waits for a PM2-managed
  gateway instead of racing it with Vite while retaining the current fallback
  until first deployment. `docs/PRODUCTION_GATEWAY_DEPLOYMENT.md` contains the
  exact approval-gated cutover, health, log, and rollback sequence.
- Verification results: the full backend suite passes 566 tests with zero skips.
  The compiled smoke harness passed health, cache, gzip, SPA, missing-asset,
  API/cookie, ranged-media, ops-blocking, and graceful-shutdown checks against a
  fake API. A real browser rendered the built sign-in screen, persisted theme,
  survived deep-link hard refresh, showed the handled dead-API error, loaded only
  the hashed bundle (no Vite client), and produced zero console warnings/errors.
  Build, lint, TypeScript, formatting, PowerShell syntax, and PM2 config syntax are
  clean. Port 8190 remained Vite PID 34928; isolated ports were closed afterward.
- Remaining risks: local verification cannot prove production HTTPS/Secure-cookie
  behavior, real authenticated API/media access, LAN routing, log/monitoring
  stability, PM2 resurrection after reboot, or rollback timing. Those remain
  explicit authorization-gated production checks. The currently running
  dispatcher binds `0.0.0.0:3334`, unlike the repository default, and warrants a
  separate access review without coupling it to this frontend rollout.
- Rollback approach: no production change during this phase; isolated process is
  terminated and temporary state removed.

### 8. Coverage policy and final gate

- Current problem: measured coverage needs risk-focused interpretation and
  sustainable regression floors rather than thresholds copied from one run.
- Risk level: medium.
- Affected files: test/coverage configuration and documentation only where useful.
- Proposed solution: report frontend/backend baselines and sensitive-module deltas;
  require tests for new/significantly modified business logic; set incremental
  floors that do not exclude difficult files.
- Tests required before changing it: complete existing and new suites plus coverage,
  builds, formatting, diff hygiene, `.only`/skip/debug/secret/environment-file audit.
- Implementation status: complete. `docs/COVERAGE_STRATEGY.md` records global and per-risk-module
  measurements, justified entrypoint gaps, exclusions, and the rule that new or
  significantly modified business logic requires corresponding behavior tests.
- Verification results: frontend coverage is 57.12% statements / 52.84%
  branches / 57.44% functions / 59.17% lines; backend is 78.82% / 74.44% /
  87.59% / 78.82%. CI floors were raised to 53/49/53/55 frontend and
  74/71/82/74 backend, retaining several points of honest-refactor headroom. The
  final gate passed formatting, lint, TypeScript, 439 frontend tests, 566 backend
  tests, both coverage runs, both production builds, compiled-gateway smoke,
  repository hygiene, and the split-process topology load test. The topology run
  exercised 100 polling clients and 32 jobs with no duplicate submissions, a
  10-job global cap, 304 ms enqueue p99, 20 ms maximum read staleness, dispatcher
  failover, and media-index convergence. It also caught and corrected a stale
  load-harness payload that did not send the now-required resolution object.
- Remaining risks: production verification stays incomplete until an authorized
  deployment, authenticated health/media smoke, monitoring window, PM2 reboot
  resurrection, and rollback drill. Low executor/recovery coverage is documented
  for targeted future failure-injection work rather than hidden by exclusions.
- Rollback approach: thresholds/documentation revert cleanly; no runtime impact.

## Change log

- 2026-08-04: captured the 9.3 starting state and safety boundary. No production
  process, PM2 definition, cloud resource, provider, credit balance, or production
  data was touched.
- 2026-08-04: fixed canonical media containment and bounded image decoding. The
  complete gate at this checkpoint passed (422 frontend + 502 backend = 924 tests,
  ESLint and TypeScript clean). Port 8190 and all production/provider state remain
  untouched.
- 2026-08-04: added the safe job-submission seam, validation and ownership gates,
  API-role SQLite integration path, provider/network tripwire, and durable-write
  rollback. The billing/idempotency features absent from production are recorded
  as explicit remaining design work, not fake-covered behavior.
- 2026-08-04: documented and decomposed the real job lifecycle behind its existing
  compatibility facade. Added immutable execution claims and focused RunPod/local
  Comfy executors without changing the persisted job schema or touching a provider.
- 2026-08-04: added risk-focused workflow, provider-input, media-route, and Comfy
  pool coverage. Fixed uploaded-media read authorization by resolving the upload's
  project ID and applying that project's ACL before either original or thumbnail
  streaming.
- 2026-08-04: split credit analytics into facade, dialog controller, composition,
  summary, table, hook, and pure-selector boundaries. Fixed unstable descending
  ties plus three demonstrated frontend teardown leaks/races (URL image loading,
  uploader completion/message timers, and Comfy follow-up refresh timers).
- 2026-08-04: verified the compiled production gateway with automated HTTP and
  real-browser smoke tests. Fixed direct-index caching and missing-asset SPA
  fallthrough, added graceful shutdown/strict port handling, hardened login-time
  resurrection, and documented an approval-gated frontend-only cutover/rollback.
- 2026-08-04: established sustainable frontend/backend coverage ratchets and
  documented risk-module baselines, justified gaps, and the new-business-logic
  testing rule without excluding awkward entrypoints or executors.
- 2026-08-04: completed the full final gate, including the 100-client split-role
  topology test. Updated that harness to submit the validated resolution object,
  then confirmed zero duplicate provider submissions, bounded global concurrency,
  dispatcher failover, and cross-worker media/read convergence. The repository
  remained local-only: no PM2 mutation, deployment, provider spend, credit use,
  production data change, or cloud change occurred; Vite PID 34928 still owns
  `0.0.0.0:8190` and the isolated gateway port is closed.
