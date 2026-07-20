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
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "3333",
        JSON_BODY_LIMIT: "15mb",
        RUNPOD_MAX_CONCURRENT_JOBS: process.env.RUNPOD_MAX_CONCURRENT_JOBS || "10",
        MEDIA_SCAN_CACHE_MS: "60000",
        MEDIA_UPLOAD_MAX_BYTES: String(1024 * 1024 * 1024),
        RUNPOD_OUTPUT_MAX_BYTES: String(1024 * 1024 * 1024),
      },
    },
  ],
};
