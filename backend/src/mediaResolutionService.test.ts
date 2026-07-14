import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectMediaResolution } from "./mediaResolutionService.js";

test("detectMediaResolution reads PNG dimensions", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-resolution-"));
  const filePath = path.join(tempDir, "image.png");
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(0x0d0a1a0a, 4);
  png.writeUInt32BE(1920, 16);
  png.writeUInt32BE(1080, 20);

  await fs.writeFile(filePath, png);
  try {
    assert.deepEqual(await detectMediaResolution(filePath, "image"), { width: 1920, height: 1080, label: "1920 × 1080" });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("detectMediaResolution reads MP4 track dimensions", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "momi-resolution-"));
  const filePath = path.join(tempDir, "video.mp4");
  const mp4 = Buffer.concat([
    mp4Box("ftyp", Buffer.alloc(8)),
    mp4Box("moov", mp4Box("trak", mp4TrackHeaderBox(2048, 1152))),
  ]);

  await fs.writeFile(filePath, mp4);
  try {
    assert.deepEqual(await detectMediaResolution(filePath, "video"), { width: 2048, height: 1152, label: "2048 × 1152" });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function mp4Box(type: string, payload: Buffer) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, "ascii");
  payload.copy(box, 8);
  return box;
}

function mp4TrackHeaderBox(width: number, height: number) {
  const payload = Buffer.alloc(88);
  payload[0] = 0;
  payload.writeUInt32BE(width * 65_536, 80);
  payload.writeUInt32BE(height * 65_536, 84);
  return mp4Box("tkhd", payload);
}
