# Job queue lifecycle and invariants

This map describes the lifecycle after the behavior-neutral decomposition. It
uses the repository's real states rather than aspirational state-machine names.

## Persisted state machine

`Job.status` has exactly six values:

```text
queued -> sending -> running -> completed
                          \-> failed
queued/sending/running ----> canceled
```

- `queued`: created by `createJob` and durably inserted before the dispatcher is
  notified. New jobs are prepended; the SQLite claimant also selects the newest
  queued `seq`, preserving current ordering.
- `sending`: the SQLite claim transaction sets this atomically with `startedAt`.
  The JSON/legacy and local-Comfy paths set it immediately before preparing or
  submitting provider work. There is no separate persisted `claimed` status.
- `running`: RunPod sets this just before `/run` (or resume) and local Comfy sets
  it after receiving `prompt_id`.
- `completed`: result media/metadata and credit usage have been collected, then
  the job is terminally persisted.
- `failed`: a provider, workflow, project, timeout, persistence-adjacent, or
  restart-recovery failure ended execution.
- `canceled`: the dispatcher observed `cancelRequested`, completed any required
  remote cancellation, and terminally persisted the result.

RunPod submission has an additional persisted substate:

```text
preparing -> submitting -> submitted
```

`runpodJobId` is the durable acknowledgement boundary. A restart may safely put a
`preparing` job with no ID back to `queued`. A job interrupted while submitting
without an acknowledged ID is failed after the takeover/timeout boundary rather
than blindly resubmitted. An acknowledged ID is resumed and must never be
submitted again.

There is no separate `processing` or `settling` status. Those are execution phases
inside `executeRunpodJob`/`executeLocalComfyJob` while the persisted status
remains `running`.

## Transition ownership

| Transition                            | Owning code                                   | Atomicity/persistence                                                                                    |
| ------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| request -> queued                     | `createJob`, `queuedJobCommit`                | Durable write completes before dispatcher wakeup; failed write removes cache orphan                      |
| queued -> sending                     | `sqliteJobStore.claimNextQueuedJob` or runner | SQLite path is one IMMEDIATE transaction with concurrency and lease checks; legacy path is process-local |
| sending -> running                    | `runpodExecution`, `localComfyExecution`      | Row upsert after provider-preparation boundary                                                           |
| active -> cancel requested            | `cancelJob`                                   | SQLite `applyToJob` atomic flag merge; API process does not terminally cancel                            |
| cancel requested -> canceled          | `settleRequestedCancellation`                 | Dispatcher-only; remote RunPod cancel must succeed before terminal status                                |
| running -> completed/failed           | provider runners                              | Persisted in runner `finally`; RunPod refuses to settle after lease loss                                 |
| active -> failed on orphan timeout    | `failExpiredOrphanedRunpodJobs`               | Dispatcher updates each expired, non-local-active row                                                    |
| interrupted -> queued/failed/canceled | `normalizeInterruptedRunpodJobs`              | Persisted synchronously during boot/takeover normalization                                               |
| terminal -> archived                  | `archiveJob`                                  | `archivedAt/by` on generated job row; scanned media goes to separate archived store                      |
| archived -> restored/deleted          | restore/delete functions                      | Generated job updates/removes main row; scanned media removes archived-store row                         |

## Persisted versus in-memory state

Persisted on each job:

- status, timestamps, `cancelRequested`, provider IDs/status/submission state;
- owner/project/model/workflow/input references;
- results, metadata, estimates, observed/actual credits, and archive fields.

Persisted outside the job row:

- SQLite sequence/revision/tombstones;
- the global dispatcher lease (`ownerId`, PID/host, heartbeat, expiry);
- scanned-media archive rows and app/project data.

Process-local only:

- job/read caches and revision cursors;
- active execution identity, RunPod concurrency count, dispatch flag/timers;
- result-move serialization promise, recovery timers/failure counts;
- debounced JSON persistence state.

## Claim and execution identity

SQLite claims are protected by three conditions in one transaction:

1. the supplied dispatcher owner still owns an unexpired global lease;
2. global `sending` + `running` count is below the configured cap;
3. the chosen row is still `queued` when updated.

Process-local execution identity is an immutable `ExecutionClaim` token held by
`ActiveExecutionRegistry`. It protects cache merges and prevents two local
runners for one job. Finishing a stale token cannot clear a newer execution. The
persisted dispatcher lease remains the cross-process authority; the local token
does not pretend to replace it.

The job row does not currently persist a per-job lease/version. Cross-process stale
settlement is prevented primarily by global lease checks before/after RunPod work
and by resuming acknowledged IDs. A future per-job claim token would require a
schema and atomic settlement predicate; this remains a documented limitation.

## Cancellation merge semantics

- API workers atomically set only `cancelRequested`; they do not overwrite the
  dispatcher's in-flight object or claim terminal success.
- Dispatcher polling re-reads the row-level flag and merges it into the in-memory
  object without replacing that object's provider state.
- Terminal jobs are immutable to cancellation: completion immediately before a
  cancellation request remains completed.
- A cancellation observed before terminal completion is remotely canceled (where
  required) and becomes canceled. If remote cancellation fails, the job remains
  active with the request flag so the dispatcher retries rather than claiming a
  false local cancellation.
- Cache refresh functions preserve active object identity and lifecycle fields.

## Archive membership

Archive state is orthogonal to lifecycle status. A generated job remains in the
main store and is considered archived when `archivedAt` exists. A live job cannot
be archived. Existing/scanned project media has no generated job row, so its
archived copy is stored in the separate archived-items store. Listing merges the
appropriate generated and scanned sets while de-duplicating IDs.

## Recovery and restart

- API-role boot never normalizes dispatcher-owned active jobs.
- Dispatcher/monolith boot or lease takeover normalizes unacknowledged interrupted
  work, resumes rows with a `runpodJobId`, and applies the global concurrency cap.
- Recent work owned by a prior live lease is not failed until the takeover timeout;
  expired orphaned rows are failed by the current owner.
- Snapshot/cache reload merges around active execution IDs so a database refresh
  cannot replace the object being mutated across awaits.
- Remote-only completed results are retried by `RemoteResultRecovery`; successful
  downloads update the durable job and de-duplicate repeated URLs.

## Public compatibility facade

External imports continue to come from `jobQueue.ts`: load/read/list/create/cancel,
archive/restore/delete, project-result mutations, persistence flush/close, queue
snapshot/count/pause, and remote-result recovery. The facade owns orchestration,
persistence-driver coordination, and the public compatibility surface. Queued job
construction, archive-list membership, lifecycle rules, execution identity, and
the RunPod/local-Comfy executors now live under `backend/src/jobQueue/`.

## Characterization coverage before extraction

Existing tests already cover atomic competing claims, stale dispatcher claims,
global concurrency, lease takeover, restart normalization/resume boundaries,
API-only cancellation flags, dispatcher cancellation settlement, live archive
rejection, snapshot/cache identity, cross-connection updates, durable ordering,
remote recovery, and queued-write rollback.

The extraction tests add immutable execution-token behavior, stale-finish
rejection, cancellation/completion ordering, duplicate settlement idempotence,
interrupted submission substates, orphan classification, archive eligibility,
deterministic queued-job construction, archive/media de-duplication, and local
Comfy result de-duplication and error propagation.
Graceful shutdown is owned by `index.ts`; it is mapped here but will be extracted
and tested with the gateway/wiring work rather than hidden inside the queue facade.
