# Topology Singleton Audit

**Status:** singleton blockers closed; 100-client topology gate passed  
**Date:** 2026-07-21  
**Scope:** mutable process-local backend state under `dispatcher:1 + api:N`

## Decision

The topology load test passes. The job queue, authentication, projects/ACLs,
media discovery, and output filename reservation have multi-process
coordination behind the SQLite flags. No known mutable singleton remains
unguarded for the RunPod topology; production remains on the monolith until
`MOMI_TOPOLOGY_SPLIT=true` is deliberately deployed.

## Findings

| State | Current behavior | Classification | Required before flip |
|---|---|---|---|
| Jobs and archived jobs | SQLite row writes, incremental revision/tombstone caches, dispatcher lease, lease-bound atomic claim, SQL active count | Ready | Keep Stage A-D integration tests in the gate. |
| Users and sessions | `APP_STATE_DRIVER=sqlite` uses indexed rows, direct token lookups, row-level mutations, transactional revocation, and one-time JSON migration | Ready behind flag | Keep the cross-connection auth and rollback-export tests in the topology gate; split-role startup requires SQLite. |
| Projects and ACLs | `APP_STATE_DRIVER=sqlite` uses direct indexed reads and transactional per-project writes; filesystem discovery is insert-only and ACL-preserving | Ready behind flag | Keep the cross-connection ACL/rename/recovery tests in the topology gate; derive `jobCount` from jobs. |
| Project folder metadata | Per-project `.lock` uses exclusive file creation and stale-lock recovery | Ready with caveat | Retain the filesystem lock; make the SQLite project row the current path/ACL authority after rename. |
| Existing-media cache | Dispatcher publishes dirty/published revisions and serialized metadata in `media_index_state`; API roles consume revisions without filesystem scans | Ready behind flag | Keep automatic sub-second publication and API-consumer tests in the topology gate. |
| Output version reservation | `latest_versions.json` updates run under the cross-process project lock and each target gets an exclusive reservation marker | Ready | Keep the paused-old-dispatcher failover test in the topology gate. |
| Workflow model and mapping cache | Read-only files loaded at boot | Conditionally ready | Treat model files as immutable deployment artifacts and restart all roles together. Add a catalog fingerprint to health before rolling deployments. |
| Comfy pool `busy` set/status cache | Process-local | Ready only for RunPod topology | Refuse split roles with `GENERATION_BACKEND=local_comfy` until Comfy ownership/status is shared or routed through the dispatcher. |
| Balance-delta activity tracker | Process-local active-operation counter | Optional blocker | Keep `CREDIT_BALANCE_DELTA_ACCOUNTING` off. Refuse split boot if it is enabled until Stage E provides shared activity rows. |
| Credit Tracker caches | Ten-second read-only caches of an external source | Safe, performance-only | Measure duplicate external traffic during the load test; no shared correctness state. |
| Recovery/reconcile/memory timers | Dispatcher-only guards | Ready | Verify one execution stream during the topology load test. |
| Kling skill cache | Read-only skill text | Ready | Restart to pick up skill-file changes. |

## Auth blocker closed

With `APP_STATE_DRIVER=sqlite`, `authService.ts` no longer authorizes from
module-level user/session snapshots. It performs indexed session and user reads
against `app-state.sqlite`; login/session creation, user edits, logout, password
reset, disable, and session revocation use row-level or transactional writes.
Conditional `last_used_at` updates are throttled without rewriting the store.

The store is separate from the jobs database, so frequent session writes do not
cause spurious job `data_version` refreshes. It provides:

- `users`: one row per user, unique normalized email and username;
- `sessions`: one row per token hash with indexed expiry and user ID;
- direct session lookup on every authenticated request;
- throttled/conditional `last_used_at` update instead of a whole-store write;
- transactional password reset/disable plus session revocation;
- one-time migration from `users.json` and `sessions.json`, which remain frozen;
- `pnpm export:app-state` to rebuild the JSON files for rollback.

The default remains `APP_STATE_DRIVER=json` for a reversible monolith rollout.
`ROLE=api` and `ROLE=dispatcher` refuse startup unless the shared SQLite app
state store is enabled.

## Project/ACL blocker closed

With `APP_STATE_DRIVER=sqlite`, project and job authorization no longer reads a
boot snapshot. `getProject()` and `getProjects()` query indexed `app_projects`
rows, so membership and path changes committed by worker A are visible to worker
B on its next read.

Create reserves a unique ID/path row before filesystem initialization. Project,
ACL, and folder-cache changes use transactional read-modify-write operations on
one current row, so concurrent edits do not replace the store. Rename merges its
new filesystem identity into the latest row and preserves concurrent ACL edits.
Boot reconciliation can complete an interrupted create or recover a rename by
project ID without accepting discovery-time default ACLs over stored ACLs.

The dispatcher-side `incrementProjectJobCount()` writes are removed; project
list counts remain derived from the jobs store. One-time `projects.json`
migration leaves the JSON file frozen, and `pnpm export:app-state` exports users,
sessions, and projects for rollback.

## Media and artifact P1 blockers closed

The dispatcher owns filesystem scans and publishes existing-media jobs to the
shared `media_index_state` row. Mutations increment a shared dirty revision; the
dispatcher refresh loop publishes a new built revision, and API workers update
their small process cache only from that row. API roles never perform their own
project-tree scan. A periodic dispatcher rebuild still discovers external
filesystem changes that did not pass through an application mutation.

Serverless output version allocation now reads and writes
`latest_versions.json` while holding the cross-process project lock. It creates
an exclusive `.momi-reservation` marker for the selected target before releasing
the lock. A replacement dispatcher therefore chooses the next version even if
an older dispatcher is paused and later resumes. Existing target files and
orphaned markers are skipped rather than overwritten.

## Required multi-process tests

1. Login on API A; authenticate the token on API B immediately. *(covered by
   cross-connection integration test)*
2. Concurrent logins on A/B; both sessions survive. Logout, password reset, and
   user disable on A are enforced by B on its next request. *(covered at the
   store/service boundary; repeat through HTTP in the topology load harness)*
3. Add/remove project membership on A; B's project and job authorization changes
   on its next request. Concurrent edits to different projects do not clobber.
   *(covered at the store/service boundary; repeat through HTTP in the topology
   load harness)*
4. Rename a project on A; B creates a job using the new path and never recreates
   or writes to the old path. *(cross-connection path visibility, ACL-preserving
   rename, and interrupted-rename recovery are covered; repeat job creation in
   the topology load harness)*
5. Move/rename media on A; B's list reflects it within one second without a full
   independent filesystem scan. *(covered by automatic dispatcher publication
   and API-role revision-consumer integration tests; repeat through HTTP)*
6. Pause the dispatcher during artifact persistence, take over the lease, then
   resume it; output versions and files remain unique and neither file is
   overwritten. *(covered with a paused `v001` writer and replacement `v002`
   writer)*
7. Split startup refuses `local_comfy` and balance-delta accounting until their
   shared-state implementations exist. *(covered by fail-closed startup tests)*

## Gate result

`pnpm test:topology` now exercises shared login/session use, ACL and project-path
visibility, 100 polling clients, burst enqueue, the SQL cap, a losing standby
dispatcher, forced leader failover with RunPod-ID resume, cancellation,
per-job credit attribution, unique output reservation, cross-worker media moves,
and sub-second media-index convergence. See
[topology-load-test.md](./topology-load-test.md). Stage E remains skipped while
balance-delta accounting is off.
