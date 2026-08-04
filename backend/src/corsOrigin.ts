// Which browser origins may make credentialed cross-origin calls to this API.
//
// This used to be `cors({ origin: true })`, which reflects back whatever Origin
// the caller sent -- i.e. any site a signed-in user visits could call this API
// from their browser and read the response. Pinning the allowlist costs nothing
// in the normal setup because the frontend talks to the API through the Vite
// /api proxy, which is same-origin and never consults CORS at all.
//
// Decision order:
//   1. No Origin header -> allowed. Server-to-server callers (RunPod fetching a
//      signed input URL, curl, the topology load test, Prometheus) never send
//      one, and CORS is not what protects those paths -- requireAuth and the
//      signed-token routes are.
//   2. "*" in the allowlist -> reflect anything. Emergency rollback only.
//   3. Exact match against CORS_ALLOWED_ORIGINS.
//   4. Loopback / private-LAN host on any port, unless disabled. This is what
//      keeps localhost:8190, the LAN host and the credit portal working.
//   5. Everything else -> denied (no Access-Control-Allow-Origin header; the
//      browser blocks the read). Denying is deliberately not an error: throwing
//      would turn a blocked page into a 500 in our own logs.

export type CorsOriginPolicy = {
  allowedOrigins: string[];
  allowPrivateOrigins: boolean;
};

// Origins carry no path, so lowercasing the whole value is safe: scheme and host
// are case-insensitive and the port is numeric.
export function normalizeOrigin(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, "");
}

export function isPrivateOriginHostname(hostname: string): boolean {
  // new URL() keeps IPv6 hosts bracketed.
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // mDNS names on the office LAN, e.g. workstation.local
  if (host.endsWith(".local")) return true;
  if (host === "::1") return true;
  // Unique-local (fc00::/7) and link-local (fe80::/10) IPv6.
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [first, second] = octets;
  if (first === 127) return true;
  if (first === 10) return true;
  if (first === 192 && second === 168) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  // Link-local autoconfiguration, seen when DHCP is unavailable on the LAN.
  if (first === 169 && second === 254) return true;
  return false;
}

export function isOriginAllowed(origin: string | undefined, policy: CorsOriginPolicy): boolean {
  if (!origin) return true;

  const normalizedAllowList = policy.allowedOrigins.map(normalizeOrigin);
  if (normalizedAllowList.includes("*")) return true;

  const normalized = normalizeOrigin(origin);
  // A sandboxed iframe or file:// document sends the opaque origin "null".
  if (!normalized || normalized === "null") return false;
  if (normalizedAllowList.includes(normalized)) return true;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  return policy.allowPrivateOrigins && isPrivateOriginHostname(parsed.hostname);
}
