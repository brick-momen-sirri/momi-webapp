# Share storage runbook — `\\10.101.41.11\ai-data$`

Momi's render output **and** uploads live on this SMB share. Storage is a
network dependency now: if the share is unreachable, Momi cannot read or write
anything. This is what to check and how to fix it.

| | |
|---|---|
| Output root | `\\10.101.41.11\ai-data$\Momi\projects` (`BRICK_PROJECTS_ROOT`) |
| Upload root | `\\10.101.41.11\ai-data$\Momi\_uploads` (`UPLOADED_MEDIA_ROOT`) |
| Service account | `svc_momi_storage` (password in Dashlane) |
| Credential store | Windows Credential Manager, under `BRICK\momen.sirri` |
| Migrated | 2026-09-01 |

## How authentication works, and why it is fragile

`10.101.41.11` sits in a DMZ with **no domain trust**, and AZWEU1AI002 is Entra
ID joined, not domain joined. There is no Kerberos path, so machine-account
auth is impossible — username and password is the only option.

The credential lives in Credential Manager as a **Domain Password** entry with
`Persist = ENTERPRISE`, so it survives reboot. It works because PM2 runs inside
`momen.sirri`'s **interactive** logon session (scheduled task
`MomiAnimation-AutoStart`, LogonType Interactive), which means the user profile
is loaded and the DPAPI vault is readable.

Three consequences worth internalising:

1. **Only Momen can store this credential.** It must land in his own vault.
2. **Converting Momi to a Windows service or an S4U scheduled task will break
   share access.** Those identities cannot decrypt the DPAPI-protected
   credential. If that migration ever happens, the credential must be
   re-stored under the new identity first.
3. **Momi does not start at boot, only at logon.** After an unattended reboot
   nothing runs until someone signs in as `momen.sirri`.

## If the share is unreachable

The `storage_unreachable` alert fires from the dispatcher when a write probe
fails (see `storageCanaryService.ts`, default every 5 minutes). Work down this
list.

```bash
# 1. Is the credential still there? Type should be "Domain Password".
cmdkey /list:10.101.41.11
```

```bash
# 2. Can the host be reached at all? ICMP is blocked; test the SMB port.
powershell -c "Test-NetConnection 10.101.41.11 -Port 445"
```

```bash
# 3. Does a bare listing work from the same identity Momi runs as?
dir \\10.101.41.11\ai-data$\Momi
```

A listing that fails with *"The user name or password is incorrect"* means the
credential is gone or stale — that is the rotation case below. A failure at
step 2 is a network or file-server problem and belongs with IT.

## After the service account password is rotated

This is the most likely cause of a sudden outage, and it fails **silently** at
the next reconnect. Re-store the credential — run this yourself, in your own
terminal, as `momen.sirri`, **not elevated**:

```bash
cmdkey /add:10.101.41.11 /user:svc_momi_storage /pass
```

Omitting the value after `/pass` makes `cmdkey` prompt without echoing, so the
password never reaches a transcript, shell history, or process arguments. If it
reports bad credentials, retry with `/user:10.101.41.11\svc_momi_storage`.

No restart is needed: the SMB redirector picks up the new credential on the
next connection. Confirm with step 3 above, and the canary should emit a
`storage_unreachable` **resolved** alert within one interval.

Never put this password in `.env`, the PM2 config, a batch file, or the repo.

## Never do these

- **Do not map a drive letter.** The old `Z:` mapping was deleted deliberately.
  A drive letter only exists inside an interactive logon, and a second mapping
  under a different user causes `ERROR_SESSION_CREDENTIAL_CONFLICT` (1219).
  Always use the UNC path.
- **Do not move the thumbnail or playable-video caches to the share.** They are
  local on purpose (`THUMBNAIL_CACHE_DIR`, `PLAYABLE_VIDEO_CACHE_DIR`, both
  under `backend/data/`): hot, small, and regenerable. Putting them on SMB adds
  network latency to every preview for no durability benefit, since losing them
  costs nothing but CPU.
- **Do not assume a machine backup covers this data.** Machine-level backups
  cover `C:`; they do not follow a UNC share. See below.

## Open items

- **Backup coverage is unconfirmed.** Before the move this data sat on `C:` and
  was covered by the daily machine backup. Machine backups do not follow a UNC
  share, so unless the file server has its own backup, ~163 GB of production
  output and uploads is now unprotected. **Ask IT to confirm `10.101.41.11` is
  backed up.** This is the highest-priority open item.
- **`ALERT_WEBHOOK_URL` is empty**, so `storage_unreachable` currently only
  reaches the logs. Set it so the canary can actually page someone.
- **The NIC negotiates 1 Gbps** on a 2.5GbE adapter (`Speed & Duplex` is
  `Auto Negotiation`, so the limit is the switch port or cable, not config).
  Fixing it is up to 2.5x on every read and write.
- **Rollback copies still occupy `C:`** — the pre-migration output tree and
  `_uploads`, roughly 163 GB. Deleting them is what actually reclaims the
  space; keep them until the share has run clean for a few days.

## Migrating another root onto the share

`backend/scripts/migrateOutputRoot.mjs` rewrites persisted absolute paths. Add
the root to its `ROOT_MOVES` list, then:

```bash
node scripts/migrateOutputRoot.mjs
```

Dry run by default, printing per-table counts. `--apply` writes, and requires
PM2 stopped — these are WAL databases and a concurrent writer would race it.
Back up `data/*.sqlite` (including `-wal` and `-shm`) first.

Paths are persisted in **five encodings** — JSON-escaped backslash, forward
slash, URL-encoded in both hex cases, and the lowercase forward-slash form used
by `app_projects.folder_path_norm`. That last column is `UNIQUE` and drives
project identity, so a rewrite that misses it looks clean and leaves every
project unmatchable.
