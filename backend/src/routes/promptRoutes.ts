// Prompt helpers: image description and the per-model prompt workflows.

import express from "express";
import { httpErrorCode, httpStatusFromError } from "../httpError.js";
import { runKlingPromptWorkflow } from "../klingPromptWorkflowService.js";
import { improveTextPromptLocally } from "../promptFallback.js";
import { describeImageWithRunpod } from "../runpodService.js";
import { runSeedancePromptWorkflow } from "../seedancePromptWorkflowService.js";

export const promptRouter = express.Router();

promptRouter.post("/api/prompt/describe-image", async (req, res) => {
  try {
    const imageBase64 = typeof req.body?.imageBase64 === "string" ? req.body.imageBase64 : "";
    const imagesBase64 = Array.isArray(req.body?.imagesBase64)
      ? req.body.imagesBase64.filter((item: unknown) => typeof item === "string" && item.trim())
      : undefined;

    if (!imageBase64.trim() && !imagesBase64?.length) {
      return res.status(400).json({ error: "imageBase64 or imagesBase64 is required." });
    }

    const result = await describeImageWithRunpod({
      imageBase64,
      imagesBase64,
      prompt: typeof req.body?.prompt === "string" ? req.body.prompt : undefined,
      systemPrompt: typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt : undefined,
      maxTokens: Number.isFinite(Number(req.body?.maxTokens)) ? Number(req.body.maxTokens) : undefined,
      temperature: Number.isFinite(Number(req.body?.temperature)) ? Number(req.body.temperature) : undefined,
    });

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not describe image.";
    res.status(httpStatusFromError(error, 502)).json({ error: message });
  }
});

promptRouter.post("/api/prompt/seedance-workflow", async (req, res) => {
  try {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    const imageBase64 = typeof req.body?.imageBase64 === "string" ? req.body.imageBase64 : "";
    const imagesBase64 = Array.isArray(req.body?.imagesBase64)
      ? req.body.imagesBase64.filter((item: unknown) => typeof item === "string" && item.trim())
      : [];
    const referenceImages = imagesBase64.length ? imagesBase64 : imageBase64.trim() ? [imageBase64] : [];

    const result = await runSeedancePromptWorkflow({
      prompt,
      imagesBase64: referenceImages,
    });

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not generate Seedance prompt.";
    res.status(httpStatusFromError(error, 502)).json({ error: message });
  }
});

promptRouter.post("/api/prompt/kling-workflow", async (req, res) => {
  try {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    const cameraPrompt = typeof req.body?.cameraPrompt === "string" ? req.body.cameraPrompt : undefined;
    const imageBase64 = typeof req.body?.imageBase64 === "string" ? req.body.imageBase64 : "";
    const imagesBase64 = Array.isArray(req.body?.imagesBase64)
      ? req.body.imagesBase64.filter((item: unknown) => typeof item === "string" && item.trim())
      : [];
    const referenceImages = imagesBase64.length ? imagesBase64 : imageBase64.trim() ? [imageBase64] : [];

    const result = await runKlingPromptWorkflow({
      prompt,
      cameraPrompt,
      imagesBase64: referenceImages,
    });

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not generate Kling prompt.";
    res.status(httpStatusFromError(error, 502)).json({ error: message });
  }
});

promptRouter.post("/api/prompt/improve", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  try {
    if (!prompt) {
      return res.status(400).json({ error: "prompt is required." });
    }

    const imageBase64 = typeof req.body?.imageBase64 === "string" ? req.body.imageBase64 : undefined;
    const imagesBase64 = Array.isArray(req.body?.imagesBase64)
      ? req.body.imagesBase64.filter((item: unknown) => typeof item === "string" && item.trim())
      : undefined;

    if (!imageBase64?.trim() && !imagesBase64?.length) {
      return res.json({
        text: improveTextPromptLocally(prompt),
        model: "local-text-prompt-fallback",
      });
    }

    const result = await describeImageWithRunpod({
      imageBase64,
      imagesBase64,
      prompt,
      systemPrompt: typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt : undefined,
      maxTokens: Number.isFinite(Number(req.body?.maxTokens)) ? Number(req.body.maxTokens) : undefined,
      temperature: Number.isFinite(Number(req.body?.temperature)) ? Number(req.body.temperature) : undefined,
    });

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not improve prompt.";
    const errorCode = httpErrorCode(error);
    if (errorCode === "prompt_helper_not_configured" || errorCode === "prompt_helper_no_text") {
      return res.json({
        text: improveTextPromptLocally(prompt),
        model: "local-text-prompt-fallback",
        warning: message,
      });
    }
    res.status(httpStatusFromError(error, 502)).json({ error: message });
  }
});
