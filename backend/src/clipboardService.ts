import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ClipboardImage = {
  name: string;
  type: string;
  dataUrl: string;
  source: string;
};

export async function readWindowsClipboardImage() {
  if (process.platform !== "win32") {
    throw new Error("System clipboard image reading is only available on Windows.");
  }

  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershellPath = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await execFileAsync(
    powershellPath,
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", clipboardScript],
    {
      maxBuffer: 90 * 1024 * 1024,
      timeout: 12_000,
      windowsHide: true,
    },
  );

  const output = stdout.trim();
  if (!output || output === "null") {
    return null;
  }

  const parsed = JSON.parse(output) as Partial<ClipboardImage>;
  if (
    typeof parsed.name !== "string" ||
    typeof parsed.type !== "string" ||
    typeof parsed.dataUrl !== "string" ||
    typeof parsed.source !== "string" ||
    !parsed.type.startsWith("image/") ||
    !parsed.dataUrl.startsWith("data:image/")
  ) {
    throw new Error("Windows clipboard did not return a readable image.");
  }

  return parsed as ClipboardImage;
}

const clipboardScript = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-MimeType([string]$ImagePath) {
  switch ([System.IO.Path]::GetExtension($ImagePath).ToLowerInvariant()) {
    ".avif" { return "image/avif" }
    ".bmp" { return "image/bmp" }
    ".gif" { return "image/gif" }
    ".jpg" { return "image/jpeg" }
    ".jpeg" { return "image/jpeg" }
    ".png" { return "image/png" }
    ".svg" { return "image/svg+xml" }
    ".webp" { return "image/webp" }
    default { return "" }
  }
}

function New-ImagePayload([string]$Name, [string]$Mime, [byte[]]$Bytes, [string]$Source) {
  if ($Bytes.Length -gt 62914560) {
    throw "Clipboard image is larger than 60 MB."
  }

  [ordered]@{
    name = $Name
    type = $Mime
    dataUrl = "data:$Mime;base64,$([Convert]::ToBase64String($Bytes))"
    source = $Source
  }
}

function New-ImageObjectPayload([System.Drawing.Image]$Image, [string]$Name, [string]$Source) {
  $stream = New-Object System.IO.MemoryStream
  try {
    $Image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return New-ImagePayload $Name "image/png" $stream.ToArray() $Source
  } finally {
    $stream.Dispose()
  }
}

function New-ImageFilePayload([string]$ImagePath, [string]$Source) {
  $resolved = Resolve-Path -LiteralPath $ImagePath -ErrorAction Stop
  $file = Get-Item -LiteralPath $resolved -ErrorAction Stop
  if ($file.Length -gt 62914560) {
    throw "Clipboard image file is larger than 60 MB."
  }

  $mime = Get-MimeType $file.FullName
  if (-not $mime) {
    return $null
  }

  return New-ImagePayload $file.Name $mime ([System.IO.File]::ReadAllBytes($file.FullName)) $Source
}

$payload = $null

if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $image = [System.Windows.Forms.Clipboard]::GetImage()
  if ($null -ne $image) {
    try {
      $payload = New-ImageObjectPayload $image "clipboard-image.png" "clipboard-image"
    } finally {
      $image.Dispose()
    }
  }
}

if ($null -eq $payload -and [System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
  foreach ($file in $files) {
    if (Test-Path -LiteralPath $file -PathType Leaf) {
      $payload = New-ImageFilePayload $file "clipboard-file"
      if ($null -ne $payload) {
        break
      }
    }
  }
}

if ($null -eq $payload -and [System.Windows.Forms.Clipboard]::ContainsText()) {
  $text = [System.Windows.Forms.Clipboard]::GetText().Trim()
  if ($text -match '^data:image\/') {
    $mime = ([regex]::Match($text, '^data:([^;,]+)')).Groups[1].Value
    $payload = [ordered]@{
      name = "clipboard-image"
      type = $mime
      dataUrl = $text
      source = "clipboard-data-url"
    }
  } else {
    $candidate = $text.Trim('"')
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $payload = New-ImageFilePayload $candidate "clipboard-text-path"
    }
  }
}

if ($null -eq $payload) {
  "null"
} else {
  $payload | ConvertTo-Json -Compress
}
`;
