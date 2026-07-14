import crypto from "node:crypto";
import path from "node:path";
import {
  brickProjectsRoot,
  comfyRoot,
  localProjectsRoot,
  runpodInputBaseUrl,
  runpodInputTokenSecret,
  runpodInputUrlTtlMs,
  uploadedMediaRoot,
} from "./config.js";

export type RunpodInputKind = "image" | "video";

type TokenPayload = {
  v: 1;
  path: string;
  kind: RunpodInputKind;
  exp: number;
};

export type ResolvedRunpodInput = {
  filePath: string;
  kind: RunpodInputKind;
};

export function createRunpodInputUrl(filePath: string, kind: RunpodInputKind) {
  if (!runpodInputBaseUrl) return undefined;
  if (!runpodInputTokenSecret) return undefined;

  const resolvedPath = path.resolve(filePath);
  if (!isAllowedRunpodInputPath(resolvedPath)) {
    throw new Error("RunPod input path is outside allowed media roots.");
  }

  const payload = encodePayload({
    v: 1,
    path: resolvedPath,
    kind,
    exp: Date.now() + runpodInputUrlTtlMs,
  });
  const token = `${payload}.${signPayload(payload)}`;
  const url = new URL("/api/runpod-input", `${runpodInputBaseUrl}/`);
  url.searchParams.set("token", token);
  return url.toString();
}

export function resolveRunpodInputToken(token: string): ResolvedRunpodInput | undefined {
  if (!token || !runpodInputTokenSecret) return undefined;
  const [payloadText, signature, ...extra] = token.split(".");
  if (!payloadText || !signature || extra.length) return undefined;
  if (!safeEqual(signature, signPayload(payloadText))) return undefined;

  const payload = decodePayload(payloadText);
  if (!payload || payload.exp < Date.now()) return undefined;

  const filePath = path.resolve(payload.path);
  if (!isAllowedRunpodInputPath(filePath)) return undefined;

  return {
    filePath,
    kind: payload.kind,
  };
}

function encodePayload(payload: TokenPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(value: string): TokenPayload | undefined {
  try {
    const payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<TokenPayload>;
    if (payload.v !== 1) return undefined;
    if (payload.kind !== "image" && payload.kind !== "video") return undefined;
    if (typeof payload.path !== "string" || !payload.path.trim()) return undefined;
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return undefined;
    return payload as TokenPayload;
  } catch {
    return undefined;
  }
}

function signPayload(payload: string) {
  return crypto.createHmac("sha256", runpodInputTokenSecret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isAllowedRunpodInputPath(filePath: string) {
  const resolvedPath = path.resolve(filePath);
  return [brickProjectsRoot, localProjectsRoot, uploadedMediaRoot, path.join(comfyRoot, "output"), path.join(comfyRoot, "input")]
    .map((root) => path.resolve(root))
    .some((root) => isPathInsideRoot(resolvedPath, root));
}

function isPathInsideRoot(filePath: string, root: string) {
  const relative = path.relative(root, filePath);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
