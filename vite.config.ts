import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Ops endpoints the app never calls. They are guarded on the backend by
// requireOpsAccess, which trusts loopback -- and this proxy runs on the same host
// as the backend, so every request it forwards arrives from 127.0.0.1 and is
// trusted. That makes the guard a no-op for anything reachable through here, so
// these four are refused at the proxy instead. Without this, any LAN user who can
// load the app can also read queue depth, process memory, disk headroom and
// backup freshness.
//
// /metrics and /ops-dashboard are not listed because only /api is proxied at all.
const BLOCKED_OPS_PATHS = ["/api/health", "/api/ops-config", "/api/alerts/recent", "/api/backup-status"];

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom"],
        },
      },
    },
  },
  server: {
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3333",
        changeOrigin: true,
        bypass: (req) => {
          const pathname = (req.url ?? "").split("?")[0];
          if (BLOCKED_OPS_PATHS.includes(pathname)) {
            // Returning false makes Vite answer 404 rather than forwarding. An
            // operator reaches these directly on the backend port from the host,
            // or with OPS_ACCESS_TOKEN from elsewhere.
            return false;
          }
          return undefined;
        },
      },
    },
  },
});
