// Signed download links handed to the RunPod worker for original-quality inputs.
// Mounted before the session middleware: it authenticates with its own
// short-lived signed token, not a user session.

import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { contentTypeFromFilePath, safeHeaderFileName, streamLocalFile } from "../httpMedia.js";
import { resolveAllowedExistingMediaPath } from "../mediaPathPolicy.js";
import { resolveRunpodInputToken } from "../runpodInputUrlService.js";

export const runpodInputRouter = express.Router();

runpodInputRouter.get("/api/runpod-input", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const input = resolveRunpodInputToken(token);
  if (!input) {
    return res.status(403).json({ error: "Invalid or expired RunPod input link." });
  }

  try {
    const filePath = await resolveAllowedExistingMediaPath(input.filePath);
    if (!filePath) {
      return res.status(404).json({ error: "RunPod input file not found." });
    }
    await fs.access(filePath);
    await streamLocalFile(req, res, filePath, {
      cacheControl: "no-store",
      contentType: contentTypeFromFilePath(filePath),
      disposition: `inline; filename="${safeHeaderFileName(path.basename(filePath))}"`,
    });
  } catch {
    res.status(404).json({ error: "RunPod input file not found." });
  }
});
