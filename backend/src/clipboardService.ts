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

// Kept separate from the final clipboard access block so the format decoder can
// be exercised with an in-memory IDataObject in tests. This matters because a
// number of Windows applications publish a native PNG/JFIF stream without a
// legacy Bitmap representation; Clipboard.ContainsImage() misses those images.
export const windowsClipboardDecoderScript = String.raw`
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

function New-ImageDataPayload($Data, [string]$Name, [string]$Mime, [string]$Source) {
  if ($Data -is [System.Drawing.Image]) {
    return New-ImageObjectPayload $Data $Name $Source
  }

  if ($Data -is [byte[]]) {
    return New-ImagePayload $Name $Mime $Data $Source
  }

  if ($Data -isnot [System.IO.Stream]) {
    return $null
  }

  $stream = [System.IO.Stream]$Data
  $originalPosition = $null
  $copy = New-Object System.IO.MemoryStream
  try {
    if ($stream.CanSeek) {
      $originalPosition = $stream.Position
      $stream.Position = 0
    }
    $stream.CopyTo($copy)
    return New-ImagePayload $Name $Mime $copy.ToArray() $Source
  } finally {
    if ($null -ne $originalPosition) {
      $stream.Position = $originalPosition
    }
    $copy.Dispose()
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

function New-ImageDataUrlPayload([string]$Value, [string]$Source) {
  $match = [regex]::Match($Value, 'data:image\/[a-zA-Z0-9.+-]+(?:;[^,\s]*)?,[^"''<>\s]+')
  if (-not $match.Success) {
    return $null
  }

  $dataUrl = $match.Value
  $mime = ([regex]::Match($dataUrl, '^data:([^;,]+)')).Groups[1].Value
  if (-not $mime.StartsWith('image/')) {
    return $null
  }

  return [ordered]@{
    name = "clipboard-image"
    type = $mime
    dataUrl = $dataUrl
    source = $Source
  }
}

function New-ImageHtmlPayload([string]$Html) {
  $payload = New-ImageDataUrlPayload $Html "clipboard-html-data-url"
  if ($null -ne $payload) {
    return $payload
  }

  # Copying an image from Explorer, Office, or an editor can leave a local
  # file:// reference in CF_HTML even when FileDrop is absent.
  $matches = [regex]::Matches($Html, '(?i)(?:src|href)\s*=\s*["''](?<url>file:[^"'']+)["'']')
  foreach ($match in $matches) {
    try {
      $uri = [Uri][System.Net.WebUtility]::HtmlDecode($match.Groups['url'].Value)
      if ($uri.IsFile -and (Test-Path -LiteralPath $uri.LocalPath -PathType Leaf)) {
        $payload = New-ImageFilePayload $uri.LocalPath "clipboard-html-file"
        if ($null -ne $payload) {
          return $payload
        }
      }
    } catch {
      # A malformed source should not hide another usable clipboard format.
    }
  }

  return $null
}

function Get-ClipboardImagePayload([System.Windows.Forms.IDataObject]$DataObject) {
  # Chrome, Firefox, Affinity, and other image tools can publish one of these
  # native encoded streams without a Bitmap view. Preserve the encoded bytes
  # instead of decoding and re-encoding them through GDI+.
  $encodedFormats = @(
    @{ Format = "PNG"; Mime = "image/png"; Name = "clipboard-image.png" },
    @{ Format = "image/png"; Mime = "image/png"; Name = "clipboard-image.png" },
    @{ Format = "JFIF"; Mime = "image/jpeg"; Name = "clipboard-image.jpg" },
    @{ Format = "JPEG"; Mime = "image/jpeg"; Name = "clipboard-image.jpg" },
    @{ Format = "image/jpeg"; Mime = "image/jpeg"; Name = "clipboard-image.jpg" },
    @{ Format = "GIF"; Mime = "image/gif"; Name = "clipboard-image.gif" },
    @{ Format = "image/gif"; Mime = "image/gif"; Name = "clipboard-image.gif" },
    @{ Format = "WebP"; Mime = "image/webp"; Name = "clipboard-image.webp" },
    @{ Format = "image/webp"; Mime = "image/webp"; Name = "clipboard-image.webp" },
    @{ Format = "AVIF"; Mime = "image/avif"; Name = "clipboard-image.avif" },
    @{ Format = "image/avif"; Mime = "image/avif"; Name = "clipboard-image.avif" },
    @{ Format = "TIFF"; Mime = "image/tiff"; Name = "clipboard-image.tiff" },
    @{ Format = "image/tiff"; Mime = "image/tiff"; Name = "clipboard-image.tiff" }
  )
  foreach ($encodedFormat in $encodedFormats) {
    if ($DataObject.GetDataPresent($encodedFormat.Format, $false)) {
      $encoded = $DataObject.GetData($encodedFormat.Format, $false)
      $payload = New-ImageDataPayload $encoded $encodedFormat.Name $encodedFormat.Mime "clipboard-$($encodedFormat.Format.ToLowerInvariant())"
      if ($null -ne $payload) {
        return $payload
      }
    }
  }

  # The standard Bitmap representation remains the most common path. Query the
  # IDataObject directly so this and the native-stream checks describe one
  # consistent clipboard snapshot.
  if ($DataObject.GetDataPresent([System.Windows.Forms.DataFormats]::Bitmap, $true)) {
    $image = $DataObject.GetData([System.Windows.Forms.DataFormats]::Bitmap, $true)
    if ($image -is [System.Drawing.Image]) {
      try {
        return New-ImageObjectPayload $image "clipboard-image.png" "clipboard-bitmap"
      } finally {
        $image.Dispose()
      }
    }
  }

  # Office, PDF, CAD, and vector-editing applications often copy a selection as
  # a metafile. GDI+ exposes those as Image objects, which can be rasterized to a
  # browser-safe PNG for the image input.
  foreach ($vectorFormat in @(
    [System.Windows.Forms.DataFormats]::EnhancedMetafile,
    [System.Windows.Forms.DataFormats]::MetafilePict
  )) {
    if (-not $DataObject.GetDataPresent($vectorFormat, $true)) {
      continue
    }
    $vectorImage = $DataObject.GetData($vectorFormat, $true)
    if ($vectorImage -is [System.Drawing.Image]) {
      try {
        return New-ImageObjectPayload $vectorImage "clipboard-image.png" "clipboard-metafile"
      } finally {
        $vectorImage.Dispose()
      }
    }
  }

  # A few creative tools use a custom format name while still returning a GDI+
  # Image object. Inspecting those objects catches the image without treating
  # arbitrary clipboard streams or text as pixels.
  foreach ($customFormat in $DataObject.GetFormats($false)) {
    try {
      $customImage = $DataObject.GetData($customFormat, $false)
      if ($customImage -is [System.Drawing.Image]) {
        try {
          return New-ImageObjectPayload $customImage "clipboard-image.png" "clipboard-custom-image"
        } finally {
          $customImage.Dispose()
        }
      }
    } catch {
      # Continue to FileDrop/HTML/text when a proprietary format cannot be read.
    }
  }

  if ($DataObject.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop, $true)) {
    $files = $DataObject.GetData([System.Windows.Forms.DataFormats]::FileDrop, $true)
    foreach ($file in $files) {
      if (Test-Path -LiteralPath $file -PathType Leaf) {
        $payload = New-ImageFilePayload $file "clipboard-file"
        if ($null -ne $payload) {
          return $payload
        }
      }
    }
  }

  # Some browser/editor copy operations include an inline data URL only in the
  # HTML clipboard format, not in the plain-text representation.
  if ($DataObject.GetDataPresent([System.Windows.Forms.DataFormats]::Html, $true)) {
    $html = $DataObject.GetData([System.Windows.Forms.DataFormats]::Html, $true)
    if ($html -is [string]) {
      $payload = New-ImageHtmlPayload $html
      if ($null -ne $payload) {
        return $payload
      }
    }
  }

  foreach ($textFormat in @(
    [System.Windows.Forms.DataFormats]::UnicodeText,
    [System.Windows.Forms.DataFormats]::Text,
    [System.Windows.Forms.DataFormats]::StringFormat
  )) {
    if (-not $DataObject.GetDataPresent($textFormat, $true)) {
      continue
    }
    $text = $DataObject.GetData($textFormat, $true)
    if ($text -isnot [string]) {
      continue
    }

    $payload = New-ImageDataUrlPayload $text "clipboard-data-url"
    if ($null -ne $payload) {
      return $payload
    }

    $candidate = $text.Trim().Trim('"')
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      $payload = New-ImageFilePayload $candidate "clipboard-text-path"
      if ($null -ne $payload) {
        return $payload
      }
    }
  }

  return $null
}
`;

const clipboardScript = `${windowsClipboardDecoderScript}
$dataObject = $null
for ($attempt = 0; $attempt -lt 4; $attempt += 1) {
  try {
    $dataObject = [System.Windows.Forms.Clipboard]::GetDataObject()
    break
  } catch {
    if ($attempt -eq 3) {
      throw
    }
    Start-Sleep -Milliseconds 75
  }
}

$payload = if ($null -eq $dataObject) { $null } else { Get-ClipboardImagePayload $dataObject }
if ($null -eq $payload) {
  "null"
} else {
  $payload | ConvertTo-Json -Compress
}
`;
