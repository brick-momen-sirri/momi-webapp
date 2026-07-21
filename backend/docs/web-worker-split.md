# Web/Worker Split (Stage 0c) — Design Doc

**Status:** proposed · **Scope:** backend horizontal scale · **Prereqs landed:** SQLite job store (live), per-row write primitives (0a), `dataVersion()` read-discovery (0b)

Goal: serve up to ~100 concurrent artists by scaling the stateless HTTP tier
horizontally, while keeping RunPod job dispatch exactly-once. This doc is the
plan for the topology increment (0c). It supersedes the "single-process Stage
0b write rewire" idea, which was found to be inseparable from topology (see
Background).

---

## 1. Decision

**One dispatcher process + N stateless API processes, coordinating through the
existing SQLite file. No Redis / external queue.**

Chosen from a design + red-team of three approaches:

| Approach | Approach-breaking findings | Verdict |
|---|---|---|
| **Single dispatcher + cluster API** | **0** | **Chosen.** |
| Leader-election (identical processes) | 2 | Rejected — stale whole-blob write can resurrect a claimed job → double-spend; more failure surface. |
| External queue (Redis/BullMQ) | 1 | Rejected — unjustified at 100 users; its own author argued against it; collapses into the single-dispatcher design. |

Rationale: RunPod is the real compute (capped at `RUNPOD_MAX_CONCURRENT_JOBS`,
default 10); the Node process only orchestrates HTTP holds. We don't need to
fan work across worker machines — we need to scale *polling/reads*. SQLite+WAL
already gives durable persistence and transactional atomic claims, so a second
stateful service would add failure surface for no benefit.

### pm2 topology

- `momi-dispatcher` — `exec_mode: fork`, `instances: 1`. Owns the dispatch loop,
  RunPod calls, the concurrency cap, background reconcilers, and all job
  *lifecycle* writes.
- `momi-api` — `exec_mode: cluster`, `instances: N`. Serves HTTP: reads, enqueue,
  narrow metadata edits, cancel requests. Never dispatches.
- Both run the same `dist/index.js`, branching on `ROLE` (`dispatcher` | `api` |
  `monolith`). Default `monolith` = today's single fork (zero behavior change).

---

## 2. Background: where we are

Current model (`backend/src/jobQueue.ts`):
- `let jobs: Job[]` is the in-memory source of truth for reads; `getJobs()`
  returns it.
- Mutations edit the array in place (`createJob` prepends; `runRunpodJob`
  mutates a job object across awaits; archive/restore/delete/rename/move/cancel
  edit array/fields) then call the debounced `persistJobs()` →
  `sqliteStore.replaceAll(jobs)`.
- Dispatch is in-process: `createJob` calls `void dispatchQueue()`;
  `dispatchRunpodJobs` re-triggers itself in a `.finally`. `activeRunpodJobs`
  and the cap are in-process counters.
- `runpodActivityTracker` (balance-delta exclusivity) is an in-process singleton.

Landed foundations (safe, dormant):
- **0a** `sqliteJobStore`: `insertJob` / `updateJob` / `applyToJob` (transactional
  read-modify-write) / `deleteJob`; `seq` assigned `MAX+1` under IMMEDIATE txn;
  `busy_timeout=5000`; per-row writes enforce the no-embedded-media contract.
- **0b** `sqliteJobStore.dataVersion()`: cross-process change signal (bumps on
  *other* connections' commits, not own).

Why the jobQueue write rewire was deferred to here: single-process, the current
dirty-diff `replaceAll` is *already* per-row for changed rows, so converting the
~20 mutation sites buys nothing until a second writer exists — and the parts that
*do* change are only correct relative to the ownership model below. So they must
be built and verified *with* topology, not before it.

---

## 3. Write-ownership model (the crux)

Every field/operation has exactly one owning role. This is what makes concurrent
writes safe without locks beyond SQLite's.

| Data / operation | Owner | Mechanism |
|---|---|---|
| Job creation (new `queued` row) | **API** | `store.insertJob(job)` |
| Lifecycle fields: `status`, `startedAt`, `completedAt`, `runpodJobId`, `runpodStatus`, `resultUrls`, `thumbnailUrls`, `outputResolution`, `creditUsage`/`creditsUsed`/`creditsActual`, `generatedPrompt`, `textArtifacts`, `errorMessage`, `creditBalance*` | **Dispatcher** | per-row `updateJob`/`applyToJob`; guarded by `WHERE status=@expected` for transitions |
| User metadata edits: `title` (rename), `folderId`/`folderName` (move), save number | **API** | `store.applyToJob(id, j => { …only these fields… })` — never touches `status` |
| **Cancellation** | **API requests, dispatcher acts** | API sets `cancelRequested=true` via `applyToJob`; the dispatcher's run loop re-reads the row each tick and aborts + sets `status='canceled'`. API never writes `status`. |
| Archive/restore of a **terminal** job | **API** | move between jobs/archived stores via per-row ops |
| Archive of a **live** (queued/running) job | **Dispatcher** (or disallow) | route through a request flag; do not let API flip a running job |
| Permanent delete (archived) | **API** | `archivedStore.deleteJob(id)` |
| Boot `sending/running → failed` normalization | **Dispatcher only** | else an API worker restart fails the dispatcher's in-flight jobs |
| Credit reconcile, remote-media recovery, media scan, memory logger | **Dispatcher only** | else N× external load + stale-cache writes |

New job field: `cancelRequested?: boolean`. New SQLite objects: a `meta` table
(dispatcher lease) and optionally `runpod_activity` (see §6).

---

## 4. Read path at scale

~100 clients / 12s ≈ 8 req/s across N API workers — almost all reads. Keep it cheap:

- Each process holds `{ dataVersion, jobs: Job[] }`. On a list read, call
  `store.dataVersion()` (sub-ms); serve the cached array if unchanged.
- On a change, refresh **incrementally**: `SELECT … WHERE seq > @watermark` plus
  an updated-at/tombstone signal for in-place edits — **never** full-table
  `JSON.parse` on every bump (that is O(history) × writeRate × N).
- The process that performed a write updates its own cache synchronously, so the
  acting user always sees their own change immediately.
- `getJobsWithExistingMedia()`'s `reconcileActualCreditsForStoredJobs()` becomes
  a **no-op on API workers** (reconcile is dispatcher-only). Media scan keeps its
  `MEDIA_SCAN_CACHE_MS` cache.

Object-identity rule (red-team, breaking if ignored): `runRunpodJob` mutates a
job object across awaits. A cache refresh must **merge by id**, never replace the
array elements the dispatcher is mid-write on. Dispatcher writes are per-row
`updateJob(job)` by id; reload merges web-originated inserts/edits without
overwriting in-flight rows.

---

## 5. Exactly-once dispatch

Two independent guarantees:

1. **Structural:** only `momi-dispatcher` (`instances:1`) runs the dispatch loop.
   Gate **all** dispatch entry points behind `isDispatcher()` — including
   `createJob`'s trailing `void dispatchQueue()` and the `.finally` re-trigger.
2. **Atomic claim (defense-in-depth):** before running a job, synchronously
   (better-sqlite3 is sync) do a read-modify-write inside an IMMEDIATE txn:
   `SELECT` the row `WHERE id=@id AND status='queued'`, set only
   `status='sending'`/`startedAt`, `UPDATE`. `changes()===1` ⇒ won; `0` ⇒ skip.
   Never write a cache-built blob for the claim (would clobber a concurrent API
   metadata edit).

**Crash-safe single dispatcher:** a bare lock file / lock row is *not* released on
SIGKILL → permanent dispatch outage. Use a **lease**: `meta` row with owner PID +
heartbeat/`expires`; a booting dispatcher steals the lease if the prior owner's
PID is dead or the heartbeat is stale. Add a health alert on "queued depth not
decreasing."

**Global concurrency cap:** count in-flight in SQL —
`SELECT COUNT(*) WHERE status IN ('sending','running')` — **not** a per-process
counter, so a failover doesn't run `2×` the cap while the old leader's RunPod
jobs are still billing.

**Dispatch trigger:** after the split, `createJob` runs on API and must not
dispatch. The dispatcher discovers queued rows via a short poll (250–500ms) **and**
re-polls immediately when a running job completes (freed capacity), so an idle
worker never leaves a web-enqueued job stuck in `queued`.

---

## 6. Balance-delta accounting across the split

`runpodActivityTracker` exclusivity is currently a per-process singleton, but the
prompt-helper billable endpoints (`describeImageWithRunpod`, kling, seedance) run
on **API** workers after the split — so the dispatcher's tracker misses their
spend and would misattribute a balance delta to a queue job.

`CREDIT_BALANCE_DELTA_ACCOUNTING` is **off by default**, so the simplest 0c ships
the split with it staying off (rely on `creditUsage`/reconcile). If it is ever
enabled under the split, either:
- (a) route all billable RunPod endpoints through the dispatcher, or
- (b) move the tracker to a shared `runpod_activity` SQLite table — **with a
  per-op owner PID + lease/TTL and stale-row reconcile**, because a crashed API
  worker's un-decremented "active op" would otherwise disable exclusivity forever
  (it fails safe to estimates, but silently and permanently).

---

## 7. SQLite concurrency specifics

- WAL (already on) + `busy_timeout` (added in 0a). **Lower `busy_timeout` to
  ~250–500ms** for 0c: better-sqlite3 is synchronous, so a long wait blocks the
  *entire* worker event loop (freezing every poller pinned to it). Pair with an
  app-level bounded retry that yields to the loop.
- Every multi-statement write uses an **IMMEDIATE** transaction (acquire the write
  lock up front; no deferred→write upgrade deadlocks).
- Keep write transactions to single-row upserts held for microseconds; **never**
  put network/disk I/O inside a write txn.
- WAL checkpoint: `wal_checkpoint(PASSIVE)` on a dispatcher timer, not `TRUNCATE`
  (which fights readers / holds longer locks).
- Windows host: cross-process WAL locking is stricter — load-test the write-lock
  wait-time **p99**, not just throughput, with the dispatcher mid-checkpoint.

---

## 8. Acceptance criteria (from the red-team — all must hold before topology flip)

1. No whole-array `replaceAll` on any runtime path — jobs **and** `archived_jobs`.
   `replaceAll` retained only for migration/export. (Grep confirms none remain on
   request/dispatch paths.)
2. Only the dispatcher writes `status`/lifecycle fields. Cancel and archive-of-live
   go through the `cancelRequested`/request flag, never a direct status write.
3. Boot `sending/running→failed` normalization is dispatcher-only.
4. Exactly-once dispatch: crash-safe lease + atomic read-modify-write claim; a
   SIGSTOP-the-leader split-brain test shows no RunPod jobId dispatched twice.
5. Concurrency cap enforced globally (SQL count), verified across a failover.
6. `runRunpodJob` never loses a completion when a concurrent enqueue/edit bumps
   `data_version` mid-hold (regression test: enqueue on a second connection during
   the hold, assert completion survives).
7. Read refresh is incremental (seq watermark), not full-table parse per bump.
8. A job enqueued while the dispatcher is idle starts within one poll tick.
9. Zero `SQLITE_BUSY`; enqueue p99 latency bounded with the dispatcher mid-checkpoint.
10. Balance-delta accounting is correct under the split, or provably off.
11. Background timers run exactly once cluster-wide (dispatcher only).
12. Rollback safety: the process refuses to boot in split topology with row-level
    writes disabled (never let `replaceAll`'s prune run under multi-writer).

---

## 9. Rollout (flag-gated, reversible at every step)

All stages default to `ROLE=monolith` (today's behavior) until explicitly flipped.

- **A.** jobQueue per-row write conversion behind a flag; single process; load-test
  equivalence. *(the ~20-site rewire, done with §3 ownership in mind)*
- **B.** Dispatcher-only guards (boot-normalization, reconcile, recovery, media
  timers) + `cancelRequested` flow; still one process.
- **C.** Incremental `data_version` read cache wired into `getJobs` /
  `getJobsWithExistingMedia`; merge-by-id; still one process.
- **D.** Dispatcher lease + atomic claim + SQL concurrency cap + dispatch poll;
  still one process (lone process always wins the lease).
- **E.** (Only if enabling balance-delta) shared `runpod_activity` table; else skip.
- **F.** Topology flip behind the flag: `dispatcher:1` + `api:2`. **Load-test
  first** (see §10). Assert every §8 criterion.
- **G.** Scale `api` instances; dispatcher stays at 1.

**Companion prerequisite before instances>1:** audit other in-memory singletons —
sessions (`sessions.json`), projects, workflow models, `comfyPool`, media cache.
A login served on worker A then a request on worker B must still work. Token auth
that reads `sessions.json` read-through per request is tolerable; anything
cached-and-mutated in memory needs the same `data_version` refresh or sticky
sessions.

---

## 10. Load test (gate for Stage F)

Simulate 100 clients polling `/api/jobs` + `/api/snapshot` every 12s, plus bursty
job creation, plus a full queue draining through the 10-cap. Assert:
- exactly-once: no RunPod `jobId` dispatched twice (incl. a SIGSTOP-leader
  split-brain scenario);
- zero `SQLITE_BUSY`; read staleness < ~1s; enqueue p99 bounded with the
  dispatcher mid-checkpoint;
- correct credit attribution; cancel works cross-process; no job lost or
  resurrected.

Watch the existing `[memory]` logs and the richer `/api/health` (queue depth,
RunPod active, memory, disk) throughout.

---

## 11. Rollback

- **Topology:** set `ROLE=monolith` (or `api` instances → 1 + stop dispatcher) and
  `pm2 reload`. Per-row writes are a strict superset of single-process behavior.
- **Schema:** `meta`, `runpod_activity`, `cancelRequested` are all additive — no
  destructive change, so a code revert needs no migration.
- **Whole-system floor:** `pnpm export:job-store` (SQLite → JSON) then
  `JOB_STORE_DRIVER=json` returns to the frozen `jobs.json`. Frozen
  `jobs.json`/`archived-items.json` from the migration remain the ultimate floor.
- **Guardrail:** refuse to boot in split topology with row-level writes off (so a
  panicked flag flip can't unleash `replaceAll`'s prune under multi-writer).

---

## 12. Effort & risk

~1 focused week. Bulk is Stage A (per-row write conversion + ownership) — the
highest-risk change, landed and load-tested single-process before any topology.
No new infrastructure. Every stage is flag-reversible. Recommend a short design
pass to finalize the §3 ownership table (esp. archive-of-live-jobs and the exact
`cancelRequested` protocol) before writing Stage A.

**Do not** rush this onto a freshly-migrated live system. Each stage is its own
PR with tests; Stage F is gated on the §10 load test.
