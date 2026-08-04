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
- Implementation status: pending; design follows the two defect fixes.
- Verification results: pending.
- Remaining risks: requested reservation/idempotency guarantees may not exist in
  the present implementation; the map must distinguish absent production behavior
  from merely untested behavior before adding a transaction contract.
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
- Implementation status: blocked by checklist order; do not begin until items 1-3
  are complete and this checklist is reviewed/updated.
- Verification results: pending.
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
- Implementation status: pending.
- Verification results: pending.
- Remaining risks: line percentage is not evidence of race coverage.
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
- Implementation status: pending.
- Verification results: pending.
- Remaining risks: snapshot-like UI tests can miss numeric drift; pure selector
  assertions are required.
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
- Implementation status: pending.
- Verification results: pending.
- Remaining risks: local verification cannot prove production cookies, proxy,
  networking, monitoring, or rollback; those remain approval-gated deployment work.
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
- Implementation status: pending.
- Verification results: pending.
- Remaining risks: production verification stays incomplete until an authorized
  deployment, health check, browser smoke, monitoring window, and rollback drill.
- Rollback approach: thresholds/documentation revert cleanly; no runtime impact.

## Change log

- 2026-08-04: captured the 9.3 starting state and safety boundary. No production
  process, PM2 definition, cloud resource, provider, credit balance, or production
  data was touched.
- 2026-08-04: fixed canonical media containment and bounded image decoding. The
  complete gate at this checkpoint passed (422 frontend + 502 backend = 924 tests,
  ESLint and TypeScript clean). Port 8190 and all production/provider state remain
  untouched.
