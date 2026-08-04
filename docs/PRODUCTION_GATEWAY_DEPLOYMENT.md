# Production Frontend Gateway Deployment

This runbook replaces the current Vite listener on port 8190 with the built
**momi-web** gateway. It leaves the API and dispatcher processes untouched.
Every command under “Authorized cutover,” “Persist,” and “Rollback” changes
production state and requires explicit approval.

## Verified local state — 2026-08-04

- Port 8190: Vite PID 34928, parent cmd.exe PID 3384, command
  node …vite.js --host 0.0.0.0 --port 8190 --strictPort.
- PM2: two online momi-api cluster workers (PIDs 16784 and 9940) and one online
  momi-dispatcher fork (PID 42244). No momi-web app exists yet.
- API traffic listens on loopback port 3333. The current dispatcher listener is
  on 0.0.0.0:3334, which differs from the repository’s loopback default. Review
  that separately; this frontend-only rollout must not reload the dispatcher.
- With MOMI_TOPOLOGY_SPLIT=true, the checked ecosystem config contains
  momi-dispatcher, momi-api, and momi-web. The web entry is one fork of
  backend/dist/frontendServer.js serving C:/Momi-Animation/dist on port 8190 and
  proxying application APIs to http://127.0.0.1:3333.
- scripts/start-on-login.ps1 preserves the current Vite fallback while momi-web
  is absent. Once PM2 manages momi-web, it waits up to 30 seconds for /healthz
  and will not race the gateway by starting Vite.
- No production process, PM2 definition, data, provider, credit balance, or
  cloud resource was changed during local verification.

## Locally verified behavior

The repeatable built-artifact check is:

```powershell
pnpm run build:production
pnpm run test:gateway-smoke
```

It launches the compiled gateway on an ephemeral loopback port against a fake
API and verifies health, index no-cache, immutable hashed assets, gzip, SPA
fallback, missing-asset 404s, cookie/API proxying, ranged media, blocked ops
routes, and graceful shutdown.

A real browser also verified the built sign-in screen, theme persistence,
deep-link hard refresh, visible API-failure handling, a hashed production script
with no Vite client, and zero console warnings/errors.

The application contains no WebSocket client/server usage and the gateway has no
upgrade handler. WebSocket proxying is therefore not a current requirement; add
an explicit upgrade proxy and tests before introducing one.

## 1. Approval-free pre-deployment gate

Run from C:\Momi-Animation:

```powershell
git status --short
git rev-parse HEAD
pnpm run format:check
pnpm run lint
pnpm exec tsc -b --pretty false
pnpm run test
pnpm --dir backend run test
pnpm run test:coverage
pnpm --dir backend run test:coverage
pnpm run build:production
pnpm run test:gateway-smoke
git diff --check
```

Parse the login script without executing it:

```powershell
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile('C:\Momi-Animation\scripts\start-on-login.ps1', [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count) { $errors | Format-List; throw 'Startup script has syntax errors.' }
```

Stop if any gate fails, a test is unexpectedly skipped, dist/index.html does not
reference hashed assets, or port 8190 is no longer the expected Vite command.

## 2. Backup and configuration snapshot

These commands copy runtime artifacts but do not change a running process. The
PM2 dump may contain secrets: keep it outside the repository and never attach or
commit it.

```powershell
$releaseId = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = "C:\Momi-Animation-deployment-backups\$releaseId"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
git rev-parse HEAD | Set-Content "$backupRoot\git-revision.txt"
Copy-Item 'C:\Momi-Animation\dist' "$backupRoot\dist" -Recurse
Copy-Item 'C:\Momi-Animation\backend\dist' "$backupRoot\backend-dist" -Recurse
Copy-Item 'C:\Momi-Animation\backend\ecosystem.config.cjs' $backupRoot
Copy-Item 'C:\Momi-Animation\scripts\start-on-login.ps1' $backupRoot
Copy-Item "$env:USERPROFILE\.pm2\dump.pm2" $backupRoot -ErrorAction Stop
pnpm --dir backend exec pm2 ls | Set-Content "$backupRoot\pm2-list.txt"
```

Capture the listener without exporting the full PM2 environment:

```powershell
$listener = Get-NetTCPConnection -LocalPort 8190 -State Listen
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
$process | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine
```

## 3. Authorized cutover

**Explicit approval is required from this point.**

Resolve and verify the listener immediately before stopping it:

```powershell
$listener = Get-NetTCPConnection -LocalPort 8190 -State Listen -ErrorAction Stop
if (@($listener).Count -ne 1) { throw 'Expected exactly one listener on port 8190.' }
$vite = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
if ($vite.CommandLine -notmatch 'vite(.CMD|\\bin\\vite\.js)?.*--port 8190.*--strictPort') { throw "Refusing to stop unexpected process: $($vite.CommandLine)" }
$oldVitePid = $vite.ProcessId
Stop-Process -Id $oldVitePid -ErrorAction Stop
while (Get-NetTCPConnection -LocalPort 8190 -State Listen -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }
```

Start only momi-web. The --only guard is mandatory; omitting it could reload the
API and dispatcher, which is outside this rollout.

```powershell
$env:MOMI_SHARED_STATE = 'true'
$env:MOMI_TOPOLOGY_SPLIT = 'true'
$env:FRONTEND_HOST = '0.0.0.0'
$env:FRONTEND_PORT = '8190'
$env:FRONTEND_DIST_PATH = 'C:/Momi-Animation/dist'
$env:FRONTEND_API_TARGET = 'http://127.0.0.1:3333'
Push-Location 'C:\Momi-Animation\backend'
pnpm exec pm2 startOrReload ecosystem.config.cjs --only momi-web --update-env
Pop-Location
```

Do not run pm2 save yet.

## 4. Health, API, media, browser, and log checks

```powershell
$health = Invoke-WebRequest 'http://127.0.0.1:8190/healthz' -UseBasicParsing
if ($health.StatusCode -ne 200 -or $health.Headers.'Cache-Control' -ne 'no-store') { throw 'Gateway health failed.' }

$index = Invoke-WebRequest 'http://127.0.0.1:8190/index.html' -UseBasicParsing
if ($index.Headers.'Cache-Control' -notmatch 'no-cache') { throw 'Index cache policy failed.' }

$deep = Invoke-WebRequest 'http://127.0.0.1:8190/projects/deployment-smoke' -UseBasicParsing
if ($deep.StatusCode -ne 200 -or $deep.Content -notmatch 'id="root"') { throw 'SPA fallback failed.' }

$opsStatus = $null
try {
  Invoke-WebRequest 'http://127.0.0.1:8190/api/health' -UseBasicParsing | Out-Null
  $opsStatus = 200
}
catch {
  $opsStatus = [int]$_.Exception.Response.StatusCode
}
if ($opsStatus -ne 404) { throw 'Ops route escaped the public gateway block.' }

$listener = Get-NetTCPConnection -LocalPort 8190 -State Listen
$servingProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
if ($servingProcess.CommandLine -match 'vite') { throw 'Vite is still serving port 8190.' }
```

Browser checklist:

1. Open a private session at http://127.0.0.1:8190/.
2. Confirm sign-in renders with no CSP, module, or console errors.
3. Sign in with an authorized non-demo account. Confirm the session cookie is
   HttpOnly, SameSite=Lax, Path=/, and Secure when HTTPS is used.
4. Open a project, a thumbnail, and a full image/video.
5. Seek a video to prove range requests and media authorization still work.
6. Navigate directly to a project URL and hard-refresh.
7. Do not create or submit a job.
8. Confirm /api/auth/me and normal application API calls return JSON, not HTML.
9. Confirm media calls return media/partial content, not the SPA shell.
10. Confirm /api/health remains unavailable through port 8190.

Logs:

```powershell
Push-Location 'C:\Momi-Animation\backend'
pnpm exec pm2 show momi-web
pnpm exec pm2 logs momi-web --lines 100 --nostream
pnpm exec pm2 ls
Pop-Location
```

Rollback immediately for any failed /healthz, Vite still owning 8190, HTML
returned for API/media, a missing asset returning 200, broken authentication or
cookies, media/range failure, CSP/module errors, repeated PM2 restarts, or new
gateway errors.

## 5. Persist after verification

**Explicit approval is required.**

```powershell
Push-Location 'C:\Momi-Animation\backend'
pnpm exec pm2 save
Pop-Location
```

In an approved maintenance window, perform a reboot/resurrection drill. Confirm
scripts/start-on-login.ps1 restores momi-web, receives /healthz within 30
seconds, and does not start Vite. After one successful reboot and rollback
drill, remove the remaining pre-deployment Vite fallback in a separate change.

## 6. Exact rollback to the current Vite definition

**Rollback changes production and requires approval unless execution of this
runbook and its automatic failure rollback were already authorized.**

Stop only the new web process:

```powershell
Push-Location 'C:\Momi-Animation\backend'
pnpm exec pm2 delete momi-web
Pop-Location
```

Restart the current Vite definition:

```powershell
$repoRoot = 'C:\Momi-Animation'
$viteArgs = @('--host', '0.0.0.0', '--port', '8190', '--strictPort')
Start-Process -FilePath "$repoRoot\node_modules\.bin\vite.CMD" -ArgumentList $viteArgs -WorkingDirectory $repoRoot -WindowStyle Hidden
Start-Sleep -Seconds 2
$listener = Get-NetTCPConnection -LocalPort 8190 -State Listen -ErrorAction Stop
$restoredWeb = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
if ($restoredWeb.CommandLine -notmatch 'vite(.CMD|\\bin\\vite\.js)?.*--port 8190.*--strictPort') { throw "Rollback listener is not the expected Vite command: $($restoredWeb.CommandLine)" }
```

If pm2 save was already run, save again after deleting momi-web so the current
API/dispatcher list remains the resurrection source. Do not resurrect the old
dump over live backend processes:

```powershell
Push-Location 'C:\Momi-Animation\backend'
pnpm exec pm2 save
Pop-Location
```

If build artifacts must be restored, restore frontend and backend from the same
snapshot; never mix versions:

```powershell
Rename-Item 'C:\Momi-Animation\dist' "dist.failed-$releaseId"
Rename-Item 'C:\Momi-Animation\backend\dist' "dist.failed-$releaseId"
Copy-Item "$backupRoot\dist" 'C:\Momi-Animation\dist' -Recurse
Copy-Item "$backupRoot\backend-dist" 'C:\Momi-Animation\backend\dist' -Recurse
```

The API and dispatcher must remain online throughout this frontend-only
rollback. Never delete/reload them or restore their SQLite files as part of this
runbook.

## Readiness distinction

- **Repository readiness:** locally verified.
- **Deployment readiness:** exact backup, cutover, health, browser, log, and
  rollback steps are prepared; authorization remains required.
- **Production verification:** not achieved until the authorized cutover,
  authenticated media/API checks, monitoring window, reboot/resurrection test,
  and rollback drill all succeed.
