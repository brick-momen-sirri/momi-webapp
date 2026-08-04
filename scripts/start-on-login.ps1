# Restores the PM2 production processes at user log-on. Before `momi-web` has
# been deployed and saved, it preserves the existing Vite fallback on port 8190.

$NodeBin = "C:\Users\momen.sirri\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
if (Test-Path "$NodeBin\node.exe") {
    $env:PATH = "$NodeBin;$env:PATH"
}

$RepoRoot = "C:\Momi-Animation"

# Give the network/profile a moment to settle right after login.
Start-Sleep -Seconds 15

# Backend: restore the saved PM2 process list (momi-dispatcher + momi-api workers).
& "$RepoRoot\backend\node_modules\.bin\pm2.CMD" resurrect

# Once momi-web is part of the saved PM2 process list, wait for its health route
# instead of racing it with Vite while PM2 finishes resurrection.
& "$RepoRoot\backend\node_modules\.bin\pm2.CMD" describe momi-web *> $null
$productionWebManaged = $LASTEXITCODE -eq 0
if ($productionWebManaged) {
    $productionWebReady = $false
    for ($attempt = 1; $attempt -le 30; $attempt += 1) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:8190/healthz" -TimeoutSec 1
            if ($health.ok -eq $true) {
                $productionWebReady = $true
                break
            }
        }
        catch {
            # PM2 may still be binding the listener; retry for at most 30 seconds.
        }
        Start-Sleep -Seconds 1
    }
    if (-not $productionWebReady) {
        throw "PM2 restored momi-web, but its health check did not pass within 30 seconds. Vite was not started."
    }
}
else {
    # Pre-deployment compatibility only. Remove this fallback after the first
    # successful momi-web deployment and rollback drill.
    $frontendRunning = Get-NetTCPConnection -LocalPort 8190 -State Listen -ErrorAction SilentlyContinue
    if ($frontendRunning) {
        return
    }
    Start-Process -FilePath "$RepoRoot\node_modules\.bin\vite.CMD" `
        -ArgumentList "--host", "0.0.0.0", "--port", "8190", "--strictPort" `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden
}
