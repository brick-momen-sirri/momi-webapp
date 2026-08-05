param(
  [string]$PnpmCommand = "pnpm"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$protectedPorts = @(8190, 3334)

function Get-ProtectedListenerSnapshot {
  $snapshot = @()
  foreach ($port in $protectedPorts) {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
      $snapshot += [pscustomobject]@{
        Port = $port
        ProcessId = $listener.OwningProcess
        CommandLine = $process.CommandLine
      }
    }
  }
  return @($snapshot | Sort-Object Port, ProcessId)
}

function Invoke-CheckedPnpm {
  param([string[]]$Arguments)
  & $PnpmCommand @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
}

$before = Get-ProtectedListenerSnapshot
$previousTopologyEntry = $env:TOPOLOGY_BACKEND_ENTRY

Push-Location $repoRoot
try {
  Invoke-CheckedPnpm -Arguments @("run", "build:e2e")
  Invoke-CheckedPnpm -Arguments @("exec", "playwright", "test")
  Invoke-CheckedPnpm -Arguments @(
    "--dir",
    "backend",
    "exec",
    "tsx",
    "--test",
    "src/sqliteBackupRestoreDrill.integration.test.ts"
  )

  $env:TOPOLOGY_BACKEND_ENTRY = Join-Path $repoRoot "backend/.e2e-dist/index.js"
  Invoke-CheckedPnpm -Arguments @("--dir", "backend", "exec", "tsx", "src/topologyLoadTest.ts")
}
finally {
  if ($null -eq $previousTopologyEntry) {
    Remove-Item Env:TOPOLOGY_BACKEND_ENTRY -ErrorAction SilentlyContinue
  }
  else {
    $env:TOPOLOGY_BACKEND_ENTRY = $previousTopologyEntry
  }
  Pop-Location
  $after = Get-ProtectedListenerSnapshot
  if (($before | ConvertTo-Json -Compress) -ne ($after | ConvertTo-Json -Compress)) {
    throw "A protected production listener changed during the drill. Before: $($before | ConvertTo-Json -Compress) After: $($after | ConvertTo-Json -Compress)"
  }
}

Write-Host "Non-production release drill passed. Protected listeners on ports 8190 and 3334 were unchanged."
