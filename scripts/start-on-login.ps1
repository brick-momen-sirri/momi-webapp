# Auto-starts the Momi Animation backend (via PM2) and frontend (Vite dev server)
# at user log-on so the project comes back up after a PC restart/shutdown.

$NodeBin = "C:\Users\momen.sirri\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
if (Test-Path "$NodeBin\node.exe") {
    $env:PATH = "$NodeBin;$env:PATH"
}

$RepoRoot = "C:\Momi-Animation"

# Give the network/profile a moment to settle right after login.
Start-Sleep -Seconds 15

# Backend: restore the saved PM2 process list (momi-dispatcher + momi-api workers).
& "$RepoRoot\backend\node_modules\.bin\pm2.CMD" resurrect

# Frontend: start the Vite dev server only if port 8190 isn't already in use.
$frontendRunning = Get-NetTCPConnection -LocalPort 8190 -State Listen -ErrorAction SilentlyContinue
if (-not $frontendRunning) {
    Start-Process -FilePath "$RepoRoot\node_modules\.bin\vite.CMD" `
        -ArgumentList "--host", "0.0.0.0", "--port", "8190", "--strictPort" `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden
}
