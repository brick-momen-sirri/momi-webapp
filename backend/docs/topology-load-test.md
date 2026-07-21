# Topology Load Gate

**Status:** passed  
**Last run:** 2026-07-21  
**Command:** `pnpm test:topology`

The gate builds the backend and starts an isolated local topology using a
temporary jobs database, temporary app-state database, temporary project tree,
temporary workflow catalog, and a local mock RunPod/Credit Tracker. It never
uses production credentials, production files, or paid RunPod compute.

## Coverage

- one active dispatcher plus a deliberately competing standby dispatcher;
- two API workers and 100 clients polling `/api/jobs` and `/api/snapshot`;
- login on API A and immediate session authentication on API B;
- project ACL and on-disk rename visibility across workers;
- 32 burst-enqueued jobs draining through the SQL-counted global cap of 10;
- durable async RunPod IDs, forced leader death, standby lease takeover, and
  status resume without resubmitting a workflow;
- cross-process cancellation of an acknowledged active RunPod job, including
  the remote `/cancel` operation, with no later resurrection;
- one credit-usage row attributed and synced per completed job;
- unique reserved output paths across all completed jobs;
- result move on API A, media read on API B, and shared media-index convergence
  within one second;
- log rejection on `SQLITE_BUSY` or `database is locked`.

## Latest result

```json
{
  "ok": true,
  "clients": 100,
  "pollCycles": 3714,
  "jobsCreated": 32,
  "jobsCompleted": 31,
  "jobsCanceled": 1,
  "runpodSubmissions": 32,
  "duplicateSubmissions": 0,
  "maxRunpodActive": 10,
  "maxBackendActive": 10,
  "enqueueP99Ms": 251,
  "maxReadStalenessMs": 6,
  "creditRowsSynced": 31,
  "dispatcherFailover": true,
  "mediaIndexConverged": true
}
```

## Production boundary

This is a deterministic application/topology gate. It does not replace a short
production canary for the reverse proxy, production disk latency, antivirus,
or the real RunPod endpoint. Production remains on the monolith unless
`MOMI_TOPOLOGY_SPLIT=true` is explicitly set.
