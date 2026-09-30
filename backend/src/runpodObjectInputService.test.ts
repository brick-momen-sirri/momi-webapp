import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "momi-runpod-object-"));

process.env.RUNPOD_INPUT_BUCKET_ENDPOINT_URL = "https://account.r2.cloudflarestorage.com/az-ai-staging";
process.env.RUNPOD_INPUT_BUCKET_ACCESS_KEY_ID = "test-access-key";
process.env.RUNPOD_INPUT_BUCKET_SECRET_ACCESS_KEY = "test-secret-key";
process.env.RUNPOD_INPUT_BUCKET_PREFIX = "momi-inputs";
process.env.LOCAL_PROJECTS_ROOT = tempRoot;
process.env.RUNPOD_ENDPOINT_ID = "endpoint-test";
process.env.RUNPOD_API_KEY = "runpod-key-test";
process.env.COMFY_ORG_API_KEY = "comfy-key-test";

const service = await import("./runpodObjectInputService.js");

test("reports configured only when all three bucket settings are present", () => {
  assert.equal(service.runpodObjectInputConfigured(), true);
});

test("presigns a URL the worker can fetch with no headers of its own", () => {
  const url = service.presign("GET", "momi-inputs/2026-09/abc.png", 900);
  const parsed = new URL(url);

  assert.equal(parsed.origin, "https://account.r2.cloudflarestorage.com");
  assert.equal(parsed.pathname, "/az-ai-staging/momi-inputs/2026-09/abc.png");
  assert.equal(parsed.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(parsed.searchParams.get("X-Amz-Expires"), "900");
  // Only the host is signed, so the worker adding a Connection or User-Agent
  // header of its own cannot invalidate the signature.
  assert.equal(parsed.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.match(parsed.searchParams.get("X-Amz-Credential") ?? "", /^test-access-key\/\d{8}\/auto\/s3\/aws4_request$/);
  assert.match(parsed.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
});

test("signs each method distinctly so a GET link cannot be replayed as a PUT", () => {
  const key = "momi-inputs/2026-09/abc.png";
  const get = new URL(service.presign("GET", key, 900)).searchParams.get("X-Amz-Signature");
  const put = new URL(service.presign("PUT", key, 900)).searchParams.get("X-Amz-Signature");
  assert.notEqual(get, put);
});

test("derives a stable key from path, size and mtime, and a new one when the file changes", () => {
  const filePath = path.join(tempRoot, "project", "input", "reference.png");
  const first = service.objectKeyForFile(filePath, 1024, 1_700_000_000_000);
  const same = service.objectKeyForFile(filePath, 1024, 1_700_000_000_000);
  const edited = service.objectKeyForFile(filePath, 2048, 1_700_000_500_000);

  assert.equal(first, same, "an unchanged file must reuse its object rather than re-uploading");
  assert.notEqual(first, edited, "an edited file must never be served from the previous object");
  assert.match(first, /^momi-inputs\/\d{4}-\d{2}\/[0-9a-f]{32}\.png$/);
});

test("keeps the extension so the stored object carries a usable type", () => {
  assert.match(service.objectKeyForFile("/tmp/clip.mp4", 10, 1), /\.mp4$/);
  assert.match(service.objectKeyForFile("/tmp/STILL.JPEG", 10, 1), /\.jpeg$/);
});

test("splits the bucket out of a path-style endpoint", () => {
  assert.deepEqual(service.parseBucketEndpoint("https://account.r2.cloudflarestorage.com/az-ai-staging"), {
    origin: "https://account.r2.cloudflarestorage.com",
    host: "account.r2.cloudflarestorage.com",
    bucket: "az-ai-staging",
  });
});

test("percent-encodes the key without escaping its separators", () => {
  const url = service.presign("GET", "momi-inputs/2026-09/a b+c(1).png", 60);
  assert.equal(new URL(url).pathname, "/az-ai-staging/momi-inputs/2026-09/a%20b%2Bc%281%29.png");
});

test("produces a signature that verifies against an independent SigV4 derivation", () => {
  const url = new URL(service.presign("GET", "momi-inputs/x.png", 300));
  const amzDate = url.searchParams.get("X-Amz-Date") ?? "";
  const dateStamp = amzDate.slice(0, 8);
  const signature = url.searchParams.get("X-Amz-Signature") ?? "";

  const canonicalQuery = [...url.searchParams.entries()]
    .filter(([name]) => name !== "X-Amz-Signature")
    .map(([name, value]) => [encodeURIComponent(name), encodeURIComponent(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = [
    "GET",
    url.pathname,
    canonicalQuery,
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const hmac = (key: string | Buffer, value: string) =>
    crypto.createHmac("sha256", key).update(value, "utf8").digest();
  const signingKey = hmac(hmac(hmac(hmac("AWS4test-secret-key", dateStamp), "auto"), "s3"), "aws4_request");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    `${dateStamp}/auto/s3/aws4_request`,
    crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");

  assert.equal(signature, hmac(signingKey, stringToSign).toString("hex"));
});

test.after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});
