import http from "node:http";
import path from "node:path";

import compression from "compression";
import express from "express";

const BLOCKED_PUBLIC_API_PATHS = new Set(["/api/health", "/api/ops-config", "/api/alerts/recent", "/api/backup-status"]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type FrontendGatewayOptions = {
  frontendDistPath: string;
  apiTarget: string;
};

export function createFrontendGateway(options: FrontendGatewayOptions) {
  const app = express();
  const indexPath = path.join(options.frontendDistPath, "index.html");

  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(compression());

  app.get("/healthz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  });

  app.use("/api", (req, res) => {
    const pathname = new URL(req.originalUrl, "http://gateway.local").pathname;
    if (BLOCKED_PUBLIC_API_PATHS.has(pathname)) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    proxyApiRequest(req, res, options.apiTarget);
  });

  app.use(
    express.static(options.frontendDistPath, {
      index: false,
      fallthrough: true,
      setHeaders: (res, filePath) => {
        if (isHashedAsset(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "public, max-age=3600");
        }
      },
    }),
  );

  app.get("*", (req, res, next) => {
    if (!req.accepts("html")) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexPath);
  });

  app.use((_req, res) => res.status(404).json({ error: "Not found." }));
  return app;
}

function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self'; font-src 'self' data:",
  );
  next();
}

function isHashedAsset(filePath: string) {
  return /[\\/]assets[\\/].+-[A-Za-z0-9_-]{6,}\.[^.]+$/.test(filePath);
}

function proxyApiRequest(req: express.Request, res: express.Response, apiTarget: string) {
  const target = new URL(req.originalUrl, ensureTrailingSlash(apiTarget));
  if (target.protocol !== "http:") {
    res.status(502).json({ error: "The internal API target must use HTTP." });
    return;
  }

  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
  headers["x-forwarded-host"] = req.headers.host;
  headers["x-forwarded-proto"] = req.protocol;
  headers["x-forwarded-for"] = req.socket.remoteAddress;

  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    },
    (upstreamResponse) => {
      res.status(upstreamResponse.statusCode ?? 502);
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) res.setHeader(name, value);
      }
      upstreamResponse.pipe(res);
    },
  );

  upstream.on("error", (error) => {
    if (!res.headersSent) res.status(502).json({ error: `Internal API unavailable: ${error.message}` });
    else res.end();
  });
  req.pipe(upstream);
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}
