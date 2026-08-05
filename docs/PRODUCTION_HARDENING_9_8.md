# Production hardening toward 9.8

This phase is intentionally non-disruptive. Repository work and verification use
`.e2e-dist`, temporary SQLite databases, fake providers, and dedicated loopback
ports. It does not overwrite the live `dist` folders, restart PM2, submit paid
provider work, or modify production data.

## Guarantees added

- The compiled production gateway is exercised by a real browser through login,
  project selection, local `blob:` media upload, and job submission. Browser/CSP,
  HTTP, accessible-name, request-ID, payload, and byte-count assertions all run in CI.
- Job creation accepts a per-user `clientRequestId`. SQLite atomically stores the
  job and unique idempotency record, matching retries return the original job, and
  key reuse with different content is rejected. The browser preserves the key and
  uploaded media URLs across network/timeout/cancel uncertainty.
- Submission failures identify local media, upload, HTTP, invalid-response,
  timeout, network, and cancellation stages. The UI exposes preparing, uploading,
  creating, and recovering states plus safe Cancel and Retry controls.
- The gateway and API propagate `X-Request-ID`. Mutations and errors are always
  logged as structured JSON without query strings; successful read traffic is
  deterministically sampled at 5% to avoid turning polling into a log-volume
  outage. Client errors retain the support reference, and Prometheus still counts
  every request by status class and latency bucket.
- The credit dashboard is loaded only when requested. Gateway policy adds explicit
  form, opener, resource, and cross-domain hardening while preserving the local
  media CSP allowances required by uploads.

## One-command isolated drill

From PowerShell, with Node 24 and pnpm available:

```powershell
./scripts/nonprod-release-drill.ps1
```

The drill snapshots the listeners on ports 8190 and 3334, builds only into
`.e2e-dist`, runs the compiled browser journey, performs a destructive-loss/restore
exercise against a temporary SQLite database, and runs the split API/dispatcher
topology against fake RunPod and temporary storage. It fails if either protected
listener changes.

## Production rollout remains approval-gated

Repository readiness is not production verification. Follow
`docs/PRODUCTION_GATEWAY_DEPLOYMENT.md` for artifact snapshots, health checks,
rolling API reload, gateway cutover, monitoring, and rollback. A reboot/PM2
resurrection drill and an off-host backup restore require an approved maintenance
window and operator-owned credentials; neither is performed by the non-production
drill.
