// Kling's 2500-character prompt limit is enforced client-side. The backend has
// its own copy of the constant (index.ts / jobRoutes.ts); if these two drift, a
// prompt passes the UI and then fails at submission, after the artist has waited.

import { describe, expect, it } from "vitest";
import type { ModelType } from "../types";
import {
  KLING_PROMPT_CHARACTER_LIMIT,
  isKlingWorkflowModel,
  isSeedanceWorkflowModel,
  klingPromptOverflowCharacters,
} from "./promptRules";

function model(overrides: Partial<ModelType> = {}): ModelType {
  return { id: "m1", label: "Model", category: "video", ...overrides } as ModelType;
}

describe("model matching", () => {
  it("matches Kling on any of the identifying fields", () => {
    expect(isKlingWorkflowModel(model({ id: "kling_v3" }))).toBe(true);
    expect(isKlingWorkflowModel(model({ label: "Kling 3.0" }))).toBe(true);
    expect(isKlingWorkflowModel(model({ backendCategory: "kling_i2v" }))).toBe(true);
    expect(isKlingWorkflowModel(model({ workflowPath: "i2v/Brick_api_kling_v3_video.json" }))).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isKlingWorkflowModel(model({ label: "KLING" }))).toBe(true);
    expect(isSeedanceWorkflowModel(model({ label: "SeeDance 2.0" }))).toBe(true);
  });

  it("only ever matches video models", () => {
    // An image model whose name happens to contain the word must not pick up the
    // video prompt rules.
    expect(isKlingWorkflowModel(model({ id: "kling_still", category: "image" }))).toBe(false);
    expect(isSeedanceWorkflowModel(model({ id: "seedance_still", category: "image" }))).toBe(false);
  });

  it("does not confuse the two model families", () => {
    expect(isKlingWorkflowModel(model({ id: "seedance2_0_i2v" }))).toBe(false);
    expect(isSeedanceWorkflowModel(model({ id: "kling_v3" }))).toBe(false);
  });

  it("tolerates absent optional fields", () => {
    expect(isKlingWorkflowModel(model({ backendCategory: undefined, workflowPath: undefined }))).toBe(false);
  });
});

describe("prompt overflow", () => {
  const kling = model({ id: "kling_v3" });

  it("reports zero at and below the limit", () => {
    expect(klingPromptOverflowCharacters(kling, "a".repeat(KLING_PROMPT_CHARACTER_LIMIT - 1))).toBe(0);
    expect(klingPromptOverflowCharacters(kling, "a".repeat(KLING_PROMPT_CHARACTER_LIMIT))).toBe(0);
  });

  it("reports the exact overflow above the limit", () => {
    expect(klingPromptOverflowCharacters(kling, "a".repeat(KLING_PROMPT_CHARACTER_LIMIT + 1))).toBe(1);
    expect(klingPromptOverflowCharacters(kling, "a".repeat(KLING_PROMPT_CHARACTER_LIMIT + 250))).toBe(250);
  });

  it("never reports overflow for a non-Kling model", () => {
    const veo = model({ id: "veo3_i2v" });
    expect(klingPromptOverflowCharacters(veo, "a".repeat(KLING_PROMPT_CHARACTER_LIMIT * 2))).toBe(0);
  });

  it("keeps the limit at the value the backend also hardcodes", () => {
    // Deliberately a literal: the point is to fail if either side is edited alone.
    expect(KLING_PROMPT_CHARACTER_LIMIT).toBe(2500);
  });
});
