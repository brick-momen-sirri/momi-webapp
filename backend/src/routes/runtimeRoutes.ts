// Small polled values the client asks for on every tick, plus the aggregated
// snapshot that batches them into one round trip.

import express from "express";
import { generationBackend, localComfyEnabled, runpodPollIntervalMs, runpodSubmissionMode, runpodTimeoutMs } from "../config.js";
import { getRequestUser } from "../authMiddleware.js";
import { readWindowsClipboardImage } from "../clipboardService.js";
import { monthlyUsageForUser } from "../creditDashboardService.js";
import { getCredits } from "../creditService.js";

import { getPodStatus } from "../podStatusService.js";

export const runtimeRouter = express.Router();

function runtimeInfo() {
  return {
    generationBackend,
    localComfyEnabled,
    runpodConfigured: Boolean(process.env.RUNPOD_ENDPOINT_ID && process.env.RUNPOD_API_KEY && process.env.COMFY_ORG_API_KEY),
    runpodSubmissionMode,
    runpodPollIntervalMs,
    runpodTimeoutMs,
  };
}

runtimeRouter.get("/api/runtime", (_req, res) => {
  res.json(runtimeInfo());
});

// Aggregates the small, parameterless values the client polls on every tick so
// they arrive in one round-trip instead of four. Jobs stay on their own
// endpoint (pagination/filtering + heavier payload).
runtimeRouter.get("/api/snapshot", async (req, res) => {
  const currentUser = getRequestUser(req);
  const [credits, podStatus] = await Promise.all([getCredits().catch(() => null), getPodStatus().catch(() => null)]);
  res.json({
    credits,
    monthlyUsage: monthlyUsageForUser(currentUser),
    runtime: runtimeInfo(),
    podStatus,
  });
});

runtimeRouter.get("/api/pods/status", async (_req, res) => {
  try {
    res.json({ status: await getPodStatus() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not read pod status." });
  }
});

runtimeRouter.get("/api/clipboard/image", async (_req, res) => {
  try {
    const image = await readWindowsClipboardImage();
    if (!image) {
      return res.status(404).json({ error: "No image found on the Windows clipboard." });
    }

    res.json({ image });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not read the Windows clipboard." });
  }
});
