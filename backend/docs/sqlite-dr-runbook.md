# SQLite Disaster Recovery — Runbook

**Status:** implemented, tested, off by default (`SQLITE_BACKUP_ENABLED=false`) · **Scope:** `data/jobs.sqlite`, `data/archived-items.sqlite`, `data/app-state.sqlite`, and generated media under `data/projects`

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

When the Azure leg and `MEDIA_BACKUP_ENABLED` are both enabled, the same cycle
also protects `LOCAL_PROJECTS_ROOT` (default `backend/data/projects`). The first
successful run uploads a full baseline. Later runs upload only files modified
since the previous successful cycle, each into a new append-only
`<prefix>/media/cycles/<timestamp>/` path. A `backup-manifest.json` is uploaded
last as the cycle's commit marker; a partial prefix without that marker is not a
restorable cycle, and the local cursor does not advance after a failed upload.
No media payload or cycle manifest is deleted or overwritten. A fixed
`<prefix>/media/restore-index.json` is republished after each committed cycle so
restoration does not depend on the production SAS having List permission. Local
deletions are deliberately not propagated, so recovery may contain extra old
files rather than silently losing them.

## 2. Configuration

All flags live in `.env.example` under "SQLite disaster recovery". Summary:

| Variable                        | Default          | Notes                                                                                                                                                                                                                                          |
| ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SQLITE_BACKUP_ENABLED`         | `false`          | Master switch.                                                                                                                                                                                                                                 |
| `SQLITE_BACKUP_INTERVAL_MS`     | `3600000` (1h)   | This is your RPO: up to one interval of data can be lost in the worst case.                                                                                                                                                                    |
| `SQLITE_BACKUP_RETENTION_COUNT` | `48`             | Local snapshots kept per database. See §4 for the retention/outage interaction.                                                                                                                                                                |
| `SQLITE_BACKUP_STAGING_DIR`     | `./data/backups` | Local staging area before/regardless of upload.                                                                                                                                                                                                |
| `BACKUP_AZURE_SAS_URL`          | _(empty)_        | Container SAS URL with **write** access. Empty = local snapshots only, no offsite leg — not real DR against host/disk loss. **Never commit this.** Set it in the process environment (or your secrets manager), not in `ecosystem.config.cjs`. |
| `BACKUP_AZURE_PREFIX`           | `momi-backend`   | Blob path prefix; a dated subfolder is added per upload.                                                                                                                                                                                       |
| `AZCOPY_PATH`                   | `azcopy`         | Override if azcopy isn't on `PATH`.                                                                                                                                                                                                            |
| `MEDIA_BACKUP_ENABLED`          | `true`           | With the master switch and Azure leg enabled, upload a full generated-media baseline followed by hourly append-only deltas from `LOCAL_PROJECTS_ROOT`. Set false only if another backup system owns that tree.                                 |

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

Rotation has no awareness of upload status — it only keeps the newest N _local_
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
3. **Verify the snapshot before trusting it.** Two separate questions, and
   `integrity_check` only answers the first:

   - _Is the file a well-formed database?_ Open it read-only and run
     `PRAGMA integrity_check;` (e.g. via the `sqlite3` CLI, or
     `node -e "const D=require('better-sqlite3'); const d=new D('<path>',{readonly:true}); console.log(d.pragma('integrity_check',{simple:true}))"`
     from `backend/` so `better-sqlite3` resolves). Expect exactly `ok`.
   - _Is it a backup of **this** database?_ `integrity_check` cannot tell you:
     an empty database is perfectly intact and returns `ok`. Run

     ```bash
     node scripts/auditBackupSnapshots.mjs
     ```

     from `backend/` and check the snapshot's row count against the rest of its
     cohort. A snapshot holding a fraction of its neighbours' population is a
     backup of something else. See §7.

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

### Restoring generated media

Generated-media cycles live at `<prefix>/media/cycles/<timestamp>/`. Generate a
temporary **Read** SAS for restoration; the production Write + Create SAS need
not be able to download backup data or enumerate the container.

1. Download the known `<prefix>/media/restore-index.json` path. It lists complete
   cycles in restore order without requiring List permission. Each listed cycle
   was added only after its `backup-manifest.json` commit marker uploaded.
2. Create a fresh restore directory. Never overlay the live tree until the
   reconstruction has been inspected.
3. Starting with the earliest manifested baseline, apply each manifested cycle
   in lexical timestamp order up to the desired recovery point. Copy each
   cycle's contents into the same restore directory and let later files replace
   earlier versions. Exclude `backup-manifest.json` from the restored content.
4. Compare the final file/byte inventory with the last applied manifest and
   spot-check representative images and videos before swapping directories.

The media history intentionally records no delete operations. A recovered tree
can therefore contain a file that had later been deleted locally; this is the
safer failure mode for generated assets. The initial baseline must be retained
for as long as any dependent deltas. If Azure lifecycle rules are introduced,
they must expire a baseline and all of its deltas as one set, only after a newer
full baseline exists.

### Operational offsite drill history

- **2026-08-05: PASS.** Downloaded backup cycle
  `2026-08-05T12-26-16-174Z` from Azure prefix
  `momi-backend/2026-08-05` into an isolated temporary directory with AzCopy.
  The downloaded `jobs`, `archived-items`, and `app-state` snapshots matched
  their local source snapshots byte-for-byte by SHA-256, returned `ok` from
  `PRAGMA integrity_check`, exposed every expected application table, and had
  readable production row counts (554 jobs, 13 archived jobs, 62 projects,
  119 users, and 7 sessions). Download plus validation took 7.99 seconds; this
  is not a full-host RTO measurement. No live database or process was touched,
  and all temporary database copies were removed after validation.

## 6. Which databases a staging directory belongs to

A staging directory serves exactly one set of source databases, and the backup
service enforces it. The first cycle to run against a directory writes
`staging-owner.json` there, recording the canonical directories of the databases
it snapshots. Every later cycle must come from those same directories or it is
refused: no snapshot, no rotation, no `backup-status.json` rewrite, and a
`backup_staging_conflict` alert.

Generated media has a separate `media-backup-owner.json` marker in the same
staging directory. It binds the offsite media history to one canonical source
tree and refuses a different `LOCAL_PROJECTS_ROOT`, preventing the same class of
foreign-harness contamination from recurring outside SQLite.

This exists because the guard is not theoretical — see §7. Note that
`SQLITE_BACKUP_STAGING_DIR` defaults to a path anchored to the **repository**
(`backend/data/backups` via `config.ts`), while every database path is
independently overridable. Any process started from this checkout with backups
enabled therefore aims at the production staging directory by default, whatever
databases it is actually pointed at.

Two situations need an operator decision:

- **You genuinely moved the data directory.** Delete `staging-owner.json` from
  the staging directory; the next cycle re-claims it for the new paths.
- **You are running a harness, drill, or dev instance.** Point it somewhere of
  its own with `SQLITE_BACKUP_STAGING_DIR`, or set `SQLITE_BACKUP_ENABLED=false`.
  The topology load test now pins both for itself.

## 7. Incident: foreign snapshots in production backup history (2026-08-05)

Between 10:43 and 10:50 UTC, twelve backup cycles wrote snapshots of a test
harness's own throwaway databases into the production staging directory — 36
files across `jobs`, `archived-items`, and `app-state`. The harness
(`topologyLoadTest.ts`) overrode every database path to a temporary directory
but inherited the repo-anchored default staging directory.

Why nothing caught it:

- Every foreign snapshot returned `integrity_check: ok`. They were valid
  databases with the correct schema — just nearly empty.
- `backup-status.json` reported a healthy cycle, because from the service's
  point of view it was one.
- Rotation is a count, so twelve foreign snapshots evicted twelve hours of
  genuine history to stay within `SQLITE_BACKUP_RETENTION_COUNT`.
- At 10:50 the newest `app-state` snapshot was one of the foreign ones. An
  operator restoring "the latest snapshot" at that moment would have replaced
  119 users and 62 projects with 1 and 1, and every check in this runbook as it
  then stood would have said the backup was fine.

Fixed by the ownership guard in §6 (`ensureStagingOwnership`), by the harness
pinning its own staging directory, and by a `backup_shrink_suspect` alert when a
snapshot collapses in size against its predecessor. The 36 foreign files were
moved to `data/backups-quarantine/` — not deleted — by
`scripts/auditBackupSnapshots.mjs`.

One honest limitation: the shrink alert and the audit script's population check
are heuristics and **under-detect**. Six of the foreign `jobs` snapshots held 66
rows against a cohort median of 551 — implausible to a human, but only 12%
below, and the harness could easily have produced more. Identity is what the
ownership marker establishes; population is only a smell test.

## 8. Verifying backups are actually healthy (day to day)

- `GET /metrics` on the dispatcher for the standard health signals (this
  endpoint doesn't currently expose backup-cycle status directly — check
  `data/backups/backup-status.json` or the `[backup]`/`[alert]` pm2 log lines
  for that).
- `data/backups/backup-status.json` — `ok`/`uploaded` per the most recent
  cycle, one entry per database plus a `media` object with baseline/delta label,
  source inventory, cursor, completion time, and any error.
- pm2 logs: `[backup]` on success, `[alert]` on trouble — and, if
  `ALERT_WEBHOOK_URL` is configured, the same alert on your webhook channel.
  The backup rules are:

  | Alert                     | Means                                                                                                |
  | ------------------------- | ---------------------------------------------------------------------------------------------------- |
  | `backup_failed`           | A snapshot failed, or the cycle completed without its offsite upload.                                |
  | `backup_upload_failed`    | A database snapshot or generated-media cycle did not reach Azure. Local-only is not DR on this host. |
  | `backup_staging_conflict` | A process tried to back up different databases into this staging directory. See §6.                  |
  | `backup_shrink_suspect`   | A snapshot collapsed in size against its predecessor. Verify the source before relying on it.        |

- `node scripts/auditBackupSnapshots.mjs` from `backend/` for a population
  check across the whole retention window (read-only unless `--apply`).

## 9. When the offsite leg is refused: reading a 403

A dead offsite leg looks identical from the app whatever the cause — an hourly
`backup_upload_failed`, `uploaded: false`, and local snapshots still `integrity:
ok`. It stayed that way undiagnosed for six days in August 2026. Run:

```
node scripts/verifyOffsiteBackup.mjs
```

from `backend/`, in a shell where `BACKUP_AZURE_SAS_URL` is set. It probes the
data plane and names the cause. Read-only by default; `--write` actually uploads
a probe blob, and on a SAS without `d` that blob cannot be removed afterwards.

**Why a bare "403" never narrowed anything.** Azure reports a permission the SAS
never carried and a permission it claims but cannot exercise with the *same*
code, `AuthorizationPermissionMismatch`. The script separates them by probing a
permission the backup SAS has always carried (`r`) against one it does not
(`l`), so the codes can be compared rather than guessed at.

| Response to a plain read      | Cause                                                          |
| ----------------------------- | -------------------------------------------------------------- |
| `404 BlobNotFound`            | Auth is fine. The problem is write-specific — see below.       |
| `AuthenticationFailed`        | The signing account key was rotated, or the SAS is malformed.  |
| `KeyBasedAuthenticationNotPermitted` | `allowSharedKeyAccess` is off; no account-key SAS can work. |
| `AuthorizationFailure`        | Refused before permissions — a storage firewall / network rule. |
| `NETWORK`                     | Egress or DNS, not Azure.                                      |

**Reads succeed and writes are refused** is the case seen on 2026-08-21. Worth
knowing what it is *not*: not expiry (`se` was three months out), not the key
(that fails the read too), not shared-key being disabled, not a network rule,
and not immutability or a legal hold — a `HEAD` on a real blob carried no
`x-ms-immutability-policy-*` or `x-ms-legal-hold` header and the lease was
`available`/`unlocked`. Azure was simply evaluating the token as read-only. Mint
a fresh container SAS and swap it in; if a brand-new SAS is refused the same
way, the restriction is on the account or container rather than the token, and
that needs the portal.

Note §3 asks for **Write, Create, List**. The SAS live through the August outage
was `sp=rcw` — carrying Read, which §3 says to withhold, and missing List, which
the media leg's restore index wants. Bring a replacement back in line with §3.

### Swapping the SAS without losing it on the next reboot

**Do not put it in `.env`.** It will be read, then discarded. `src/env.ts` only
fills a key that is *absent* from `process.env`, and `ecosystem.config.cjs` sets
`BACKUP_AZURE_SAS_URL: process.env.BACKUP_AZURE_SAS_URL || ""` unconditionally --
so the key is always present, empty when nothing supplied it, and the file value
loses. `ALERT_WEBHOOK_URL` behaves the same way. Both must come from **User
scope**. A value in `.env` looks set on disk, reads as empty in the process, and
produces exactly the silent-but-configured failure this runbook exists for.

Both layers are needed, and the middle step is the one that has bitten twice:

1. Set it at **User scope**, so a fresh `pm2 start` inherits it:
   `[Environment]::SetEnvironmentVariable("BACKUP_AZURE_SAS_URL", "<url>", "User")`
2. Restart the dispatcher **with `--update-env`**, from a shell that can see
   User scope:
   `pm2 restart ecosystem.config.cjs --only momi-dispatcher --update-env`
   A plain `pm2 restart momi-dispatcher` replays pm2's *stored* env and the new
   value never reaches the process — that is exactly how the 2026-08-06 → 08-12
   outage went unnoticed for six days. Before using `--update-env`, confirm no
   key lives only in pm2's stored env (it rebuilds the env from the ecosystem
   `env` block plus the launching shell, silently dropping anything else).
3. `pm2 save`, so `pm2 resurrect` after a reboot replays the new value too.

A cycle fires immediately on dispatcher boot, so the swap self-verifies within a
minute or so — but confirm it directly rather than waiting for the alert to stop:

```
node scripts/verifyOffsiteBackup.mjs
```

Then check `data/backups/backup-status.json` shows `uploaded: true`.
