# SQLite Disaster Recovery — Runbook

**Status:** implemented, tested, off by default (`SQLITE_BACKUP_ENABLED=false`) · **Scope:** `data/jobs.sqlite`, `data/archived-items.sqlite`, `data/app-state.sqlite`

This host (`C:\Momi-Animation`, machine AZWEU1AI002) has a single local volume (`C:`).
A local snapshot alone only protects against corruption or an accidental delete —
it cannot survive a lost disk or a lost host. Real DR requires shipping snapshots
**offsite**, which is what the Azure Blob upload leg is for.

---

## 1. What runs, and where

`backend/src/sqliteBackupService.ts`, started from `boot()` in `index.ts` — **dispatcher/monolith only**, never on API workers (they'd all snapshot the same shared databases and race on the same staging directory / offsite prefix).

Each cycle, per database:
1. Open the live database **read-only** and take a consistent copy via SQLite's
   online backup API (`better-sqlite3`'s `db.backup()`). This copies committed
   pages including anything still sitting in the WAL — a plain file copy of just
   the `.sqlite` file would silently lose those rows. Proven by
   `sqliteBackupService.test.ts`'s "captures WAL-resident rows that a plain file
   copy would lose" test.
2. Open the copy, switch it to `journal_mode = DELETE` (checkpoints/removes any
   WAL state so the shipped artifact is one self-contained file, not one that
   needs `-wal`/`-shm` sidecars to be valid), then run `PRAGMA integrity_check`.
   A snapshot that fails integrity is discarded, not shipped.
3. Rotate old local snapshots down to `SQLITE_BACKUP_RETENTION_COUNT` (default
   48).
4. If `BACKUP_AZURE_SAS_URL` is set, upload every snapshot from this cycle via
   `azcopy` under a dated prefix, with a 15-minute timeout so a hung azcopy
   process can never permanently wedge future cycles.

Every cycle writes `data/backups/backup-status.json` (at/ok/uploaded per-database
result) and raises `[alert]` events — routed through the same `emitAlert`/
`ALERT_WEBHOOK_URL` path the health watchdog uses — on any failure:
`backup_failed` (a snapshot or the overall cycle failed) and
`backup_upload_failed` (offsite shipping failed specifically).

## 2. Configuration

All flags live in `.env.example` under "SQLite disaster recovery". Summary:

| Variable | Default | Notes |
|---|---|---|
| `SQLITE_BACKUP_ENABLED` | `false` | Master switch. |
| `SQLITE_BACKUP_INTERVAL_MS` | `3600000` (1h) | This is your RPO: up to one interval of data can be lost in the worst case. |
| `SQLITE_BACKUP_RETENTION_COUNT` | `48` | Local snapshots kept per database. See §4 for the retention/outage interaction. |
| `SQLITE_BACKUP_STAGING_DIR` | `./data/backups` | Local staging area before/regardless of upload. |
| `BACKUP_AZURE_SAS_URL` | *(empty)* | Container SAS URL with **write** access. Empty = local snapshots only, no offsite leg — not real DR against host/disk loss. **Never commit this.** Set it in the process environment (or your secrets manager), not in `ecosystem.config.cjs`. |
| `BACKUP_AZURE_PREFIX` | `momi-backend` | Blob path prefix; a dated subfolder is added per upload. |
| `AZCOPY_PATH` | `azcopy` | Override if azcopy isn't on `PATH`. |

Enabling requires a restart (`pm2 restart momi-dispatcher` — see the reload
sequence used for other changes to this backend).

**azcopy must be installed separately** — it does not ship with this repo.
[Download from Microsoft](https://learn.microsoft.com/azure/storage/common/storage-use-azcopy-v10)
and confirm `azcopy --version` works from the same account pm2 runs as.

## 3. Getting a SAS URL (least-privilege)

Generate a **container-scoped** SAS with only what backups need:
- Permissions: **Write, Create, List** (not Read/Delete — a compromised SAS
  shouldn't be able to read or destroy existing backups).
- Expiry: as short as your rotation discipline allows (e.g. 90 days), calendared
  to be regenerated before it lapses — an expired SAS fails every upload the
  same way a network outage would (see §4), so treat renewal as a scheduled task.
- IP restriction: scope to this host's egress IP if it's static.

**Known, accepted limitation:** for the duration of each `azcopy copy` process,
the full destination URL — SAS signature included — is a plain argument on that
process's command line, visible to anything on the host that can enumerate
process command lines (Task Manager's "Command line" column, `Get-CimInstance
Win32_Process`, `wmic process get commandline`). This is inherent to azcopy's
CLI, not a bug in this integration — there is no supported way to hand it a
destination SAS out-of-band for a plain local→blob copy. The mitigations above
(narrow permissions, short expiry, IP restriction) bound the blast radius; they
don't eliminate the exposure. If that residual risk is unacceptable, the
alternative is `azcopy login` with a managed identity / OAuth instead of a SAS —
out of scope for this v1 but a reasonable follow-up.

## 4. Known trade-off: the retention window is also your outage grace period

Rotation has no awareness of upload status — it only keeps the newest N *local*
files. If offsite upload starts failing (expired SAS, network outage, wrong
container) and is never fixed, the oldest local snapshot is deleted every cycle
once the count exceeds retention. With the shipped defaults (hourly, keep 48),
**an offsite outage longer than ~48 hours produces a permanent, unrecoverable
gap** for whatever period ages out during the outage — one hour at a time, for
as long as the outage continues.

This is a deliberate, bounded trade-off (unlimited local retention risks
filling this host's one disk during a long outage), not an oversight — but it
means `backup_upload_failed`/`backup_failed` alerts firing repeatedly is a
**48-hour SLA to act on**, not a "get to it eventually" notice. Point
`ALERT_WEBHOOK_URL` at something that actually pages someone before relying on
this in production.

Similarly, retention is a fixed **count**, not a byte budget. At today's sizes
(jobs.sqlite ~1.5MB, archived-items.sqlite ~4KB, app-state.sqlite ~20MB) 48
snapshots of each is under 1GB total — trivial against this host's ~31GB free.
Revisit this if any of these databases grow an order of magnitude, since
nothing here currently checks free disk space before writing a snapshot (the
health watchdog's generic `disk_low` alert, default floor 5GiB, is the only
backstop, and it doesn't attribute the cause to backups specifically).

## 5. Restore procedure (tested)

This exact sequence — using the real application store code, not raw SQL — is
proven by the `sqliteBackupRestoreDrill.integration.test.ts` automated test,
which runs on every `pnpm test` (so a change that breaks restore fails CI, not
a real incident). If you're restoring for real, the automated version is the
same logic this describes:

1. **Stop the affected process(es).** For a full-host recovery, stop
   everything (`pm2 stop momi-dispatcher momi-api`). Never restore into a
   database a live process still has open.
2. **Identify the snapshot to restore.** Local: `data/backups/<name>-<label>.sqlite`,
   newest first (label is an ISO-ish timestamp, lexically sortable). Offsite:
   `azcopy copy "<container-sas-url>/<prefix>/<date>/<name>-<label>.sqlite" <local-path>`
   to pull it back down first.
3. **Verify the snapshot before trusting it** — open it read-only and run
   `PRAGMA integrity_check;` (e.g. via the `sqlite3` CLI, or
   `node -e "const D=require('better-sqlite3'); const d=new D('<path>',{readonly:true}); console.log(d.pragma('integrity_check',{simple:true}))"`
   from `backend/` so `better-sqlite3` resolves). Expect exactly `ok`.
4. **Clear any stale sidecars at the live path** before copying in the
   restored file: delete `<live-path>-wal` and `<live-path>-shm` if they exist.
   (SQLite's own WAL salt-matching would ignore a mismatched stale WAL anyway,
   but starting clean removes any ambiguity.)
5. **Copy the verified snapshot over the live path** (`jobs.sqlite`,
   `archived-items.sqlite`, or `app-state.sqlite` as needed). The shipped
   snapshot is already a single self-contained file (no WAL sidecars of its
   own — see §1 step 2), so this is a plain file copy, not a SQLite-aware
   operation.
6. **Restart the process(es).** `pm2 restart momi-dispatcher`, then rolling
   `pm2 reload momi-api`.
7. **Verify.** `GET /api/health` on the dispatcher: lease held, queue counts
   sane. `GET /metrics`: `momi_dispatcher_lease_held` back to 1 on the
   dispatcher. Spot-check recently active jobs/projects through the app itself.
   Anything created or changed after the restored snapshot's timestamp and
   before the incident is genuinely gone — that gap is the RPO from §2.

## 6. Verifying backups are actually healthy (day to day)

- `GET /metrics` on the dispatcher for the standard health signals (this
  endpoint doesn't currently expose backup-cycle status directly — check
  `data/backups/backup-status.json` or the `[backup]`/`[alert]` pm2 log lines
  for that).
- `data/backups/backup-status.json` — `ok`/`uploaded` per the most recent
  cycle, one entry per database.
- pm2 logs: `[backup]` on success, `[alert]` (`backup_failed` /
  `backup_upload_failed`) on failure — and, if `ALERT_WEBHOOK_URL` is
  configured, the same alert on your webhook channel.
