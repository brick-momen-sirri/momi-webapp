// Hands RunPod inputs to the worker as presigned object-storage URLs instead of
// base64 inside the request body.
//
// Why this exists: every media input this deployment has ever sent went inline,
// under RunPod's request-body cap. That cap is what forces a large still through
// a JPEG re-encode before it is sent, and it is the reason a whole-image edit
// loses sharpness. The worker never needed that -- handler.py checks each input
// value for an http(s) prefix before trying base64 and, when it finds one,
// downloads it with requests.get, adding no Authorization header and following
// redirects. A presigned GET is therefore already a supported input shape and
// needs no change to the worker image. Confirmed against the live Animation
// endpoint on 2026-09-24: a presigned R2 URL round-tripped through LoadImage,
// and an unreachable URL failed in 702ms with "Error uploading <name>: 404" --
// before the prompt is queued, so a bad URL costs no GPU time.
//
// SigV4 is implemented here rather than pulled in as an SDK. The whole surface
// is one presign and one PUT; @aws-sdk/client-s3 would add tens of megabytes to
// a backend that has six runtime dependencies.
//
// Written against Cloudflare R2 (region "auto"), which is what the Animation
// endpoint already uses for its *outputs* -- the same bucket, reached with the
// same credentials. Nothing here is R2-specific: AWS S3 works by setting the
// region and endpoint.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import https from "node:https";
import path from "node:path";

import {
  runpodInputBucketAccessKeyId,
  runpodInputBucketEndpoint,
  runpodInputBucketPrefix,
  runpodInputBucketRegion,
  runpodInputBucketSecretAccessKey,
  runpodInputUrlTtlMs,
} from "./config.js";
import type { RunpodInputKind } from "./runpodInputUrlService.js";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

export function runpodObjectInputConfigured() {
  return Boolean(runpodInputBucketEndpoint && runpodInputBucketAccessKeyId && runpodInputBucketSecretAccessKey);
}

/**
 * Upload a local file and return a presigned GET URL the worker can download.
 *
 * Returns undefined when object storage is not configured, so callers fall back
 * to whatever they did before rather than failing a job over an unset env var.
 */
export async function uploadRunpodObjectInput(filePath: string, kind: RunpodInputKind): Promise<string | undefined> {
  if (!runpodObjectInputConfigured()) return undefined;

  const stats = await fs.stat(filePath);
  const key = objectKeyForFile(filePath, stats.size, stats.mtimeMs);
  const contentType = mimeTypeForPath(filePath, kind);

  // Keyed on identity rather than content so that deciding whether to upload
  // costs a stat rather than a full read -- these files live on an SMB share
  // where reading a large video twice is the expensive part. A file that
  // changes gets a new mtime and therefore a new key, so a stale object can
  // never be served in place of an edited one.
  if (!(await objectExists(key))) {
    await putObject(key, filePath, stats.size, contentType);
  }

  return presign("GET", key, Math.ceil(runpodInputUrlTtlMs / 1000));
}

export function objectKeyForFile(filePath: string, size: number, mtimeMs: number) {
  const fingerprint = crypto
    .createHash("sha256")
    .update(`${path.resolve(filePath)}|${size}|${Math.round(mtimeMs)}`)
    .digest("hex")
    .slice(0, 32);
  const extension = path.extname(filePath).toLowerCase();
  const month = new Date().toISOString().slice(0, 7);
  const prefix = runpodInputBucketPrefix ? `${runpodInputBucketPrefix}/` : "";
  return `${prefix}${month}/${fingerprint}${extension}`;
}

function mimeTypeForPath(filePath: string, kind: RunpodInputKind) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? (kind === "video" ? "video/mp4" : "image/png");
}

async function objectExists(key: string) {
  const url = presign("HEAD", key, 300);
  const response = await fetch(url, { method: "HEAD" }).catch(() => undefined);
  return response?.status === 200;
}

/**
 * Streamed rather than buffered: a normalized video input can be hundreds of
 * megabytes, and reading one into memory to hash it would defeat the point of
 * moving off the inline path. Signing with UNSIGNED-PAYLOAD is what makes that
 * possible -- the signature covers the URL and the host, not the bytes.
 */
function putObject(key: string, filePath: string, size: number, contentType: string) {
  const url = presign("PUT", key, 3600);
  return new Promise<void>((resolve, reject) => {
    const request = https.request(
      new URL(url),
      { method: "PUT", headers: { "content-type": contentType, "content-length": String(size) } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) return resolve();
          const body = Buffer.concat(chunks).toString("utf8").slice(0, 300);
          reject(new Error(`Object storage rejected the RunPod input upload with HTTP ${status}. ${body}`));
        });
      },
    );
    request.on("error", reject);
    createReadStream(filePath)
      .on("error", (error) => {
        request.destroy();
        reject(error);
      })
      .pipe(request);
  });
}

export function presign(method: "GET" | "PUT" | "HEAD", key: string, expiresInSeconds: number) {
  const { origin, host, bucket } = parseBucketEndpoint(runpodInputBucketEndpoint);
  const { amzDate, dateStamp } = timestamps();
  const canonicalUri = `/${encodePath(bucket ? `${bucket}/${key}` : key)}`;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${runpodInputBucketAccessKeyId}/${dateStamp}/${runpodInputBucketRegion}/s3/aws4_request`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(query[name])}`)
    .join("&");
  const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const scope = `${dateStamp}/${runpodInputBucketRegion}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(dateStamp), stringToSign).toString("hex");
  return `${origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export function parseBucketEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  return { origin: url.origin, host: url.host, bucket: url.pathname.replace(/^\/+|\/+$/g, "") };
}

function signingKey(dateStamp: string) {
  const dateKey = hmac(`AWS4${runpodInputBucketSecretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, runpodInputBucketRegion);
  return hmac(hmac(regionKey, "s3"), "aws4_request");
}

function hmac(key: string | Buffer, value: string) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function sha256Hex(value: string) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function timestamps() {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

// S3 signing uses RFC 3986, which encodeURIComponent misses in five places.
function encodeRfc3986(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(value: string) {
  return value.split("/").map(encodeRfc3986).join("/");
}
