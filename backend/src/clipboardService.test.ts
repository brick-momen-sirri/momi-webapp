import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { windowsClipboardDecoderScript } from "./clipboardService.js";

const execFileAsync = promisify(execFile);

async function decodeFixture(fixtureScript: string) {
  const script = `${windowsClipboardDecoderScript}
${fixtureScript}
`;
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershellPath = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await execFileAsync(
    powershellPath,
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
    { maxBuffer: 2 * 1024 * 1024, timeout: 10_000, windowsHide: true },
  );
  return JSON.parse(stdout.trim()) as { name: string; type: string; dataUrl: string; source: string };
}

test(
  "the Windows decoder reads a native PNG stream without a Bitmap representation",
  { skip: process.platform !== "win32" },
  async () => {
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XbGrAAAAAElFTkSuQmCC";
    const payload = await decodeFixture(`
$dataObject = New-Object System.Windows.Forms.DataObject
$stream = New-Object System.IO.MemoryStream(,[Convert]::FromBase64String("${pngBase64}"))
try {
  $dataObject.SetData("PNG", $false, $stream)
  Get-ClipboardImagePayload $dataObject | ConvertTo-Json -Compress
} finally {
  $stream.Dispose()
}
`);
    assert.deepEqual(payload, {
      name: "clipboard-image.png",
      type: "image/png",
      dataUrl: `data:image/png;base64,${pngBase64}`,
      source: "clipboard-png",
    });
  },
);

test(
  "the Windows decoder accepts encoded streams copied by external creative applications",
  { skip: process.platform !== "win32" },
  async () => {
    const payload = await decodeFixture(`
$dataObject = New-Object System.Windows.Forms.DataObject
$stream = New-Object System.IO.MemoryStream(,[byte[]](1, 2, 3, 4))
try {
  $dataObject.SetData("WebP", $false, $stream)
  Get-ClipboardImagePayload $dataObject | ConvertTo-Json -Compress
} finally {
  $stream.Dispose()
}
`);

    assert.deepEqual(payload, {
      name: "clipboard-image.webp",
      type: "image/webp",
      dataUrl: "data:image/webp;base64,AQIDBA==",
      source: "clipboard-webp",
    });
  },
);

test(
  "the Windows decoder rasterizes a custom GDI image copied by an external application",
  { skip: process.platform !== "win32" },
  async () => {
    const payload = await decodeFixture(`
$dataObject = New-Object System.Windows.Forms.DataObject
$bitmap = New-Object System.Drawing.Bitmap(2, 2)
try {
  $dataObject.SetData("CreativeAppImage", $false, $bitmap)
  Get-ClipboardImagePayload $dataObject | ConvertTo-Json -Compress
} finally {
  $bitmap.Dispose()
}
`);

    assert.equal(payload.name, "clipboard-image.png");
    assert.equal(payload.type, "image/png");
    assert.equal(payload.source, "clipboard-custom-image");
    assert.match(payload.dataUrl, /^data:image\/png;base64,iVBOR/);
  },
);
