module.exports = {
  apps: [
    {
      name: "momi-backend",
      cwd: "C:/Momi-Animation/backend",
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      // Give the graceful-shutdown handler time to drain in-flight RunPod jobs
      // and flush job state before PM2 sends SIGKILL (default is only 1600ms).
      kill_timeout: 32000,
      // Safety net: recycle the process if it leaks past this. Image encoding
      // and large in-memory job history are the likely growth sources.
      max_memory_restart: "1500M",
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "3333",
        JSON_BODY_LIMIT: "15mb",
        RUNPOD_MAX_CONCURRENT_JOBS: process.env.RUNPOD_MAX_CONCURRENT_JOBS || "10",
        MEDIA_SCAN_CACHE_MS: "60000",
        MEDIA_UPLOAD_MAX_BYTES: String(1024 * 1024 * 1024),
        RUNPOD_OUTPUT_MAX_BYTES: String(1024 * 1024 * 1024),
        // Persist jobs to SQLite. On first boot, jobs.json / archived-items.json
        // are migrated into jobs.sqlite / archived-items.sqlite; those .json
        // files remain frozen as a fallback. To roll back, set this to "json"
        // BEFORE new jobs accumulate on SQLite (see the caveat below), or export
        // the SQLite store back to JSON first.
        JOB_STORE_DRIVER: "sqlite",
        // Let sharp image encoding use more libuv threads so it doesn't starve
        // file streaming under concurrent load.
        UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || "12",
      },
    },
  ],
};
