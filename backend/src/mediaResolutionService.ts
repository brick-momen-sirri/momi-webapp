import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Resolution } from "./types.js";

type OutputKind = "image" | "video" | "sequence";

const execFileAsync = promisify(execFile);
const IMAGE_HEADER_BYTES = 2 * 1024 * 1024;
const VIDEO_PARSE_MAX_BYTES = 64 * 1024 * 1024;

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const videoExtensions = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);

export async function detectMediaResolution(filePath: string, outputKind?: OutputKind): Promise<Resolution | undefined> {
  const extension = path.extname(filePath).toLowerCase();
  if (outputKind === "image" || outputKind === "sequence" || imageExtensions.has(extension)) {
    const header = await readFileStart(filePath, IMAGE_HEADER_BYTES);
    return parseImageResolution(header);
  }

  if (outputKind === "video" || videoExtensions.has(extension)) {
    const parsed = await parseVideoResolution(filePath, extension);
    if (parsed) return parsed;
    return detectVideoResolutionWithFfprobe(filePath);
  }

  return undefined;
}

export function resolutionLabel(resolution?: Resolution) {
  return resolution ? `${resolution.width} × ${resolution.height}` : undefined;
}

function toResolution(width: number, height: number): Resolution | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  const normalizedWidth = Math.round(width);
  const normalizedHeight = Math.round(height);
  if (normalizedWidth <= 0 || normalizedHeight <= 0) return undefined;
  if (normalizedWidth > 100_000 || normalizedHeight > 100_000) return undefined;
  return { width: normalizedWidth, height: normalizedHeight, label: `${normalizedWidth} × ${normalizedHeight}` };
}

async function readFileStart(filePath: string, maxBytes: number) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readWholeFileIfSmall(filePath: string, maxBytes: number) {
  const stat = await fs.stat(filePath);
  if (stat.size > maxBytes) return undefined;
  return fs.readFile(filePath);
}

function parseImageResolution(buffer: Buffer): Resolution | undefined {
  return parsePngResolution(buffer)
    ?? parseJpegResolution(buffer)
    ?? parseWebpResolution(buffer)
    ?? parseGifResolution(buffer)
    ?? parseBmpResolution(buffer);
}

function parsePngResolution(buffer: Buffer): Resolution | undefined {
  if (buffer.length < 24) return undefined;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return undefined;
  return toResolution(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
}

function parseJpegResolution(buffer: Buffer): Resolution | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;

  while (offset + 4 < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;

    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) break;

    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;

    if (isJpegStartOfFrame(marker) && length >= 7) {
      const frameStart = offset + 2;
      return toResolution(buffer.readUInt16BE(frameStart + 3), buffer.readUInt16BE(frameStart + 1));
    }

    offset += length;
  }

  return undefined;
}

function isJpegStartOfFrame(marker: number) {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function parseWebpResolution(buffer: Buffer): Resolution | undefined {
  if (buffer.length < 30) return undefined;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return undefined;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > buffer.length) break;

    if (chunkType === "VP8X" && chunkSize >= 10) {
      const width = 1 + readUInt24LE(buffer, dataOffset + 4);
      const height = 1 + readUInt24LE(buffer, dataOffset + 7);
      return toResolution(width, height);
    }

    if (chunkType === "VP8L" && chunkSize >= 5 && buffer[dataOffset] === 0x2f) {
      const bits = buffer.readUInt32LE(dataOffset + 1);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return toResolution(width, height);
    }

    if (chunkType === "VP8 " && chunkSize >= 10) {
      const startCodeOffset = dataOffset + 3;
      if (
        buffer[startCodeOffset] === 0x9d &&
        buffer[startCodeOffset + 1] === 0x01 &&
        buffer[startCodeOffset + 2] === 0x2a
      ) {
        const width = buffer.readUInt16LE(startCodeOffset + 3) & 0x3fff;
        const height = buffer.readUInt16LE(startCodeOffset + 5) & 0x3fff;
        return toResolution(width, height);
      }
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  return undefined;
}

function parseGifResolution(buffer: Buffer): Resolution | undefined {
  if (buffer.length < 10) return undefined;
  const signature = buffer.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
  return toResolution(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
}

function parseBmpResolution(buffer: Buffer): Resolution | undefined {
  if (buffer.length < 26 || buffer.toString("ascii", 0, 2) !== "BM") return undefined;
  return toResolution(buffer.readInt32LE(18), Math.abs(buffer.readInt32LE(22)));
}

function readUInt24LE(buffer: Buffer, offset: number) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

async function parseVideoResolution(filePath: string, extension: string): Promise<Resolution | undefined> {
  if (extension !== ".mp4" && extension !== ".mov" && extension !== ".m4v") return undefined;
  const buffer = await readWholeFileIfSmall(filePath, VIDEO_PARSE_MAX_BYTES).catch(() => undefined);
  return buffer ? parseMp4Resolution(buffer) : undefined;
}

function parseMp4Resolution(buffer: Buffer): Resolution | undefined {
  const candidates: Resolution[] = [];
  walkMp4Boxes(buffer, 0, buffer.length, 0, candidates);
  return candidates.sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

function walkMp4Boxes(buffer: Buffer, start: number, end: number, depth: number, candidates: Resolution[]) {
  if (depth > 8) return;
  let offset = start;

  while (offset + 8 <= end) {
    const parsed = readMp4Box(buffer, offset, end);
    if (!parsed) break;

    if (parsed.type === "tkhd") {
      const resolution = parseTrackHeaderResolution(buffer, parsed.payloadStart, parsed.end);
      if (resolution) candidates.push(resolution);
    } else if (isMp4Container(parsed.type)) {
      walkMp4Boxes(buffer, parsed.payloadStart, parsed.end, depth + 1, candidates);
    }

    offset = parsed.end;
  }
}

function readMp4Box(buffer: Buffer, offset: number, parentEnd: number) {
  if (offset + 8 > parentEnd) return undefined;
  let size = buffer.readUInt32BE(offset);
  const type = buffer.toString("ascii", offset + 4, offset + 8);
  let headerSize = 8;

  if (size === 1) {
    if (offset + 16 > parentEnd) return undefined;
    const largeSize = buffer.readBigUInt64BE(offset + 8);
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    size = Number(largeSize);
    headerSize = 16;
  } else if (size === 0) {
    size = parentEnd - offset;
  }

  if (size < headerSize) return undefined;
  const end = offset + size;
  if (end > parentEnd) return undefined;
  return { type, payloadStart: offset + headerSize, end };
}

function isMp4Container(type: string) {
  return type === "moov" || type === "trak" || type === "mdia" || type === "minf" || type === "stbl" || type === "edts";
}

function parseTrackHeaderResolution(buffer: Buffer, start: number, end: number): Resolution | undefined {
  if (start + 8 > end) return undefined;
  const version = buffer[start];
  const dimensionOffset = version === 1 ? 92 : 80;
  const widthOffset = start + dimensionOffset;
  if (widthOffset + 8 > end) return undefined;
  return toResolution(buffer.readUInt32BE(widthOffset) / 65_536, buffer.readUInt32BE(widthOffset + 4) / 65_536);
}

async function detectVideoResolutionWithFfprobe(filePath: string): Promise<Resolution | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath],
      { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> };
    const stream = parsed.streams?.find((item) => Number.isFinite(item.width) && Number.isFinite(item.height));
    return stream ? toResolution(Number(stream.width), Number(stream.height)) : undefined;
  } catch {
    return undefined;
  }
}
