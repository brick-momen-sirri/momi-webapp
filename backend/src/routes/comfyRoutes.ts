// Local ComfyUI pool control and the workflow model catalogue.

import express from "express";
import { requireAdmin } from "../authMiddleware.js";
import { type ComfyPoolAction, getServers, refreshServers, runComfyPoolAction } from "../comfyPool.js";
import { localComfyEnabled } from "../config.js";
import { getWorkflowModels } from "../workflowService.js";

export const comfyRouter = express.Router();

comfyRouter.get("/api/comfy/servers", async (_req, res) => {
  if (!localComfyEnabled) {
    return res.json({ servers: [] });
  }
  await refreshServers();
  res.json({ servers: getServers() });
});

comfyRouter.post("/api/comfy/action", requireAdmin, async (req, res) => {
  try {
    if (!localComfyEnabled) {
      return res
        .status(400)
        .json({ error: "Local ComfyUI pool controls are disabled. Set GENERATION_BACKEND=local_comfy for local development." });
    }
    const action = typeof req.body?.action === "string" ? req.body.action : "";
    const port = Number(req.body?.port);
    const result = await runComfyPoolAction({
      action: action as ComfyPoolAction,
      port: Number.isFinite(port) ? port : undefined,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not manage the Comfy pool." });
  }
});

comfyRouter.get("/api/models", (_req, res) => {
  res.json({ models: getWorkflowModels() });
});
