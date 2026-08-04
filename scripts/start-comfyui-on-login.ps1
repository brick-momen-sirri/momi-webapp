# Auto-starts the local ComfyUI (Credit Portal) instance at user log-on
# so it comes back up after a PC restart/shutdown.

$ComfyDir = "C:\Users\momen.sirri\Desktop\ComfyUI_windows_portable_nvidia_Credit_Portal\ComfyUI_windows_portable"

# Give Windows/GPU drivers a moment to settle right after login.
Start-Sleep -Seconds 20

# ComfyUI listens on 127.0.0.1:8160 (see run_nvidia_gpu.bat) - skip if already running.
$comfyRunning = Get-NetTCPConnection -LocalPort 8160 -State Listen -ErrorAction SilentlyContinue
if (-not $comfyRunning) {
    Start-Process -FilePath "$ComfyDir\run_nvidia_gpu.bat" `
        -WorkingDirectory $ComfyDir `
        -WindowStyle Minimized
}
