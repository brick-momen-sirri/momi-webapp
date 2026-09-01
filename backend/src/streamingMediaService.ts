import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import { renameWithRetry, rmWithRetry } from "./fsRetry.js";

export class ByteLimit extends Transform {
  private receivedBytes = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  get bytes() {
    return this.receivedBytes;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.receivedBytes += chunk.length;

    if (this.receivedBytes > this.maxBytes) {
      callback(new Error(`Media exceeds the maximum allowed size of ${this.maxBytes} bytes.`));
      return;
    }

    callback(null, chunk);
  }
}

/**
 * Atomic write whose final name is the sha256 of the content, so re-uploading a
 * byte-identical file costs nothing.
 *
 * Uploads used to be named `<timestamp>-<random>-<original>`, which made every
 * re-upload of the same source file a fresh full copy -- `_uploads` grew from
 * 5.4 GB to 12.7 GB in a fortnight. A one-off hardlink pass reclaimed 3 GB in
 * August, but that trick died when uploads moved to SMB, which does not carry
 * hardlinks. Content addressing fixes it at write time instead, and over the
 * network it also means a duplicate transfers its bytes once and then writes
 * zero.
 *
 * `directory` deliberately keeps the caller's `<projectId>/<userId>` layout:
 * the media read guard authorizes an upload by parsing the project id out of
 * the first path segment, so only the file name is content-addressed. That
 * bounds dedup to a single project+user. Dedup across projects would need that
 * authorization redesigned -- it cannot be done by changing the path alone.
 */
export async function writeContentAddressedStream(
  source: NodeJS.ReadableStream,
  directory: string,
  extension: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ filePath: string; bytesWritten: number; deduplicated: boolean }> {
  await fs.mkdir(directory, { recursive: true });

  const limiter = new ByteLimit(maxBytes);
  const hasher = createHash("sha256");
  const digestTap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hasher.update(chunk);
      callback(null, chunk);
    },
  });
  const temporaryPath = path.join(directory, `.upload-${randomUUID()}.part`);

  try {
    await pipeline(source, limiter, digestTap, createWriteStream(temporaryPath, { flags: "wx" }), { signal });
    const filePath = path.join(directory, `${hasher.digest("hex")}${extension}`);

    // Uploads are write-once, so an existing name with this digest is the same
    // bytes. Drop the copy we just made rather than paying to rename over it.
    const alreadyStored = await fs
      .stat(filePath)
      .then((stat) => stat.size > 0)
      .catch(() => false);
    if (alreadyStored) {
      await rmWithRetry(temporaryPath, { force: true }).catch(() => undefined);
      return { filePath, bytesWritten: limiter.bytes, deduplicated: true };
    }

    await renameWithRetry(temporaryPath, filePath);
    return { filePath, bytesWritten: limiter.bytes, deduplicated: false };
  } catch (error) {
    await rmWithRetry(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeStreamAtomically(
  source: NodeJS.ReadableStream,
  finalPath: string,
  maxBytes: number,
  signal?: AbortSignal,
) {
  await fs.mkdir(path.dirname(finalPath), { recursive: true });

  const limiter = new ByteLimit(maxBytes);
  const temporaryPath = `${finalPath}.${randomUUID()}.part`;

  try {
    await pipeline(source, limiter, createWriteStream(temporaryPath, { flags: "wx" }), { signal });
    await renameWithRetry(temporaryPath, finalPath);
    return { bytesWritten: limiter.bytes };
  } catch (error) {
    await rmWithRetry(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function responseBodyToNodeStream(response: Response) {
  if (!response.body) {
    throw new Error("Response did not include a readable body.");
  }

  // Node's Readable.fromWeb wants its own ReadableStream nominal type, which is
  // structurally but not nominally the DOM one fetch returns. This cast is the
  // documented interop escape, not a modelling gap.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  return Readable.fromWeb(response.body as any);
}
