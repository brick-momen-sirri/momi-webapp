import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

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
    await pipeline(
      source,
      limiter,
      createWriteStream(temporaryPath, { flags: "wx" }),
      { signal },
    );
    await fs.rename(temporaryPath, finalPath);
    return { bytesWritten: limiter.bytes };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function responseBodyToNodeStream(response: Response) {
  if (!response.body) {
    throw new Error("Response did not include a readable body.");
  }

  return Readable.fromWeb(response.body as any);
}
