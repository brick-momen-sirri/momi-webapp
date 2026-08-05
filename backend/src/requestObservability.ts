import crypto from "node:crypto";

import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "./authMiddleware.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const LATENCY_BUCKETS_MS = [100, 300, 1_000, 3_000, 10_000, 30_000] as const;

type StatusClass = "2xx" | "3xx" | "4xx" | "5xx";

export type HttpRequestMetricsSnapshot = {
  inFlight: number;
  total: number;
  durationMsTotal: number;
  byStatusClass: Record<StatusClass, number>;
  latencyBuckets: Array<{ upperBoundMs: number; count: number }>;
};

const metrics = {
  inFlight: 0,
  total: 0,
  durationMsTotal: 0,
  byStatusClass: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 } as Record<StatusClass, number>,
  latencyBucketCounts: LATENCY_BUCKETS_MS.map(() => 0),
};

export function resolveRequestId(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : crypto.randomUUID();
}

export function createRequestObservability(
  log: (entry: Record<string, unknown>) => void = (entry) => console.log(JSON.stringify(entry)),
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = resolveRequestId(req.headers["x-request-id"]);
    const started = process.hrtime.bigint();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);
    metrics.inFlight += 1;

    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      recordHttpRequest(res.statusCode, durationMs);
      const userId = (req as AuthenticatedRequest).authUser?.id;
      if (shouldLogRequest(req.method, res.statusCode, requestId)) {
        log({
          event: "http_request",
          request_id: requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: Math.round(durationMs * 10) / 10,
          ...(userId ? { user_id: userId } : {}),
        });
      }
    };

    res.once("finish", record);
    res.once("close", record);
    next();
  };
}

export function getHttpRequestMetricsSnapshot(): HttpRequestMetricsSnapshot {
  return {
    inFlight: metrics.inFlight,
    total: metrics.total,
    durationMsTotal: metrics.durationMsTotal,
    byStatusClass: { ...metrics.byStatusClass },
    latencyBuckets: LATENCY_BUCKETS_MS.map((upperBoundMs, index) => ({
      upperBoundMs,
      count: metrics.latencyBucketCounts[index],
    })),
  };
}

function recordHttpRequest(status: number, durationMs: number) {
  metrics.inFlight = Math.max(0, metrics.inFlight - 1);
  metrics.total += 1;
  metrics.durationMsTotal += durationMs;
  metrics.byStatusClass[statusClass(status)] += 1;
  for (let index = 0; index < LATENCY_BUCKETS_MS.length; index += 1) {
    if (durationMs <= LATENCY_BUCKETS_MS[index]) metrics.latencyBucketCounts[index] += 1;
  }
}

function statusClass(status: number): StatusClass {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

function shouldLogRequest(method: string, status: number, requestId: string) {
  if (status >= 400 || !["GET", "HEAD", "OPTIONS"].includes(method)) return true;
  let checksum = 0;
  for (const character of requestId) checksum = (checksum + character.charCodeAt(0)) % 20;
  return checksum === 0;
}
