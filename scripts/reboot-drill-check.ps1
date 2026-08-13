# One-shot post-boot verification for the momi-web resurrection drill.
#
# Registered as a logon-triggered scheduled task so the drill records its own
# result with nobody watching. Writes a single report file and exits; it changes
# no process and starts nothing. Remove the task and this script once the drill
# has passed:
#
#   Unregister-ScheduledTask -TaskName 'MomiAnimation-RebootDrillCheck' -Confirm:$false
#
# Pass criteria: four PM2 apps online, /healthz returns ok:true, and port 8190 is
# owned by the PM2 fork running frontendServer.js -- NOT vite.js.

$ErrorActionPreference = 'Continue'

$reportDir = 'C:\Momi-Animation-deployment-backups\reboot-drill'
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
$report = Join-Path $reportDir ("drill-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".txt")

function Emit([string]$line) {
    $line | Tee-Object -FilePath $report -Append | Out-Null
}

Emit "=== momi-web reboot drill ==="
Emit ("report written:  " + (Get-Date -Format 'o'))
Emit ("last boot:       " + (Get-CimInstance Win32_OperatingSystem).LastBootUpTime)
Emit ""

# The app's own startup task sleeps 15s then polls /healthz for up to 30s. Wait
# past that budget before judging, or a slow-but-correct start reads as a failure.
Emit "waiting up to 120s for the gateway to answer..."
$ready = $false
for ($attempt = 1; $attempt -le 120; $attempt += 1) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8190/healthz' -TimeoutSec 2
        if ($health.ok -eq $true) { $ready = $true; Emit ("gateway answered ok:true after ~" + $attempt + "s"); break }
    }
    catch { }
    Start-Sleep -Seconds 1
}
if (-not $ready) { Emit "gateway did NOT report ok:true within 120s" }
Emit ""

$failures = New-Object System.Collections.ArrayList

# --- PM2 process list ---
$env:PATH = 'C:\Users\momen.sirri\AppData\Local\Programs\nodejs-portable\node-v24.15.0-win-x64;' + $env:PATH
$pm2 = 'C:\Momi-Animation\backend\node_modules\.bin\pm2.CMD'
Emit "--- pm2 process list ---"
$pm2List = & $pm2 ls 2>$null
foreach ($line in ($pm2List | Select-String -Pattern 'momi-')) { Emit ("  " + $line.Line) }
foreach ($app in 'momi-api', 'momi-dispatcher', 'momi-web') {
    $online = ($pm2List | Select-String -Pattern ($app + '.*online') -Quiet)
    Emit ("  " + $app.PadRight(18) + " online: " + [bool]$online)
    if (-not $online) { [void]$failures.Add("$app-not-online") }
}
Emit ""

# --- health body, not just the status code: Vite's SPA fallback also returns 200 ---
Emit "--- gateway health ---"
try {
    $raw = Invoke-WebRequest 'http://127.0.0.1:8190/healthz' -UseBasicParsing -TimeoutSec 5
    $parsed = $raw.Content | ConvertFrom-Json
    Emit ("  status=" + $raw.StatusCode + "  content-type=" + $raw.Headers.'Content-Type' + "  ok=" + $parsed.ok)
    if ($parsed.ok -ne $true) { [void]$failures.Add('health-body') }
}
catch { Emit ("  health request failed: " + $_.Exception.Message); [void]$failures.Add('health-unreachable') }
Emit ""

# --- who owns 8190: the gateway fork, or did Vite win the race? ---
Emit "--- port 8190 owner ---"
try {
    $listener = Get-NetTCPConnection -LocalPort 8190 -State Listen -ErrorAction Stop
    Emit ("  listener count: " + @($listener).Count)
    if (@($listener).Count -ne 1) { [void]$failures.Add('multiple-listeners') }
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener[0].OwningProcess)"
    Emit ("  pid: " + $owner.ProcessId)
    Emit ("  cmd: " + $owner.CommandLine)
    if ($owner.CommandLine -match 'vite') { Emit "  VITE OWNS 8190 - the fallback beat the gateway"; [void]$failures.Add('vite-owns-8190') }
}
catch { Emit "  nothing listening on 8190"; [void]$failures.Add('no-listener') }
Emit ""

# --- did the fallback branch fire when it should not have? ---
Emit "--- startup decision ---"
& $pm2 describe momi-web *> $null
$managed = ($LASTEXITCODE -eq 0)
Emit ("  pm2 describe momi-web exit 0 (managed): " + $managed)
if (-not $managed) { [void]$failures.Add('momi-web-not-managed') }
$viteProcs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'vite' })
Emit ("  stray vite processes: " + $viteProcs.Count)
if ($viteProcs.Count -gt 0) { [void]$failures.Add('stray-vite-process') }
Emit ""

# --- serving behavior ---
Emit "--- serving checks ---"
foreach ($case in @(
    @{ name = 'spa-deep-link'; url = 'http://127.0.0.1:8190/projects/reboot-drill'; expect = 200 },
    @{ name = 'ops-blocked'; url = 'http://127.0.0.1:8190/api/health'; expect = 404 },
    @{ name = 'api-proxy-401'; url = 'http://127.0.0.1:8190/api/auth/me'; expect = 401 }
)) {
    $status = $null
    try { $status = (Invoke-WebRequest $case.url -UseBasicParsing -TimeoutSec 5).StatusCode }
    catch { if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode } }
    $ok = ($status -eq $case.expect)
    Emit ("  " + $case.name.PadRight(16) + " got=" + $status + " expect=" + $case.expect + "  " + $(if ($ok) { 'PASS' } else { 'FAIL' }))
    if (-not $ok) { [void]$failures.Add($case.name) }
}
Emit ""

Emit "=== RESULT ==="
if ($failures.Count -eq 0) {
    Emit "DRILL PASSED - the gateway came back on its own after reboot."
}
else {
    Emit ("DRILL FAILED - " + ($failures -join ', '))
    Emit ""
    Emit "To restore service by hand:"
    Emit "  cd C:\Momi-Animation\backend; .\node_modules\.bin\pm2.CMD resurrect"
    Emit "If that does not bring back momi-web, restore the old startup fallback:"
    Emit "  Copy-Item 'C:\Momi-Animation-deployment-backups\20260804-205417\Momi Backend PM2 Resurrect.cmd' ([Environment]::GetFolderPath('Startup'))"
}
Emit ("report: " + $report)
