import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ModelType } from "../types";
import { ModelSelector } from "./ModelSelector";

function model(overrides: Partial<ModelType> = {}): ModelType {
  return {
    id: "brick_api_flux3_i2v",
    label: "Flux 3 Image To Video",
    description: "Loaded from i2v.",
    category: "video",
    backendCategory: "image_to_video",
    workflowPath: "C:\\Momi-Animation\\workflow\\i2v\\Brick_api_flux3_i2v.json",
    cost: 438,
    estimatedTime: "2-5 min",
    requiresImage: true,
    imageSlotCount: 1,
    ...overrides,
  };
}

describe("Flux 3 workflow option", () => {
  it("is enabled for a discovered Flux 3 video workflow", () => {
    const flux = model();
    render(<ModelSelector models={[flux]} selectedModel={flux} onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Flux 3" })).toBeEnabled();
  });

  it("stays disabled in image editing until an official workflow exists", () => {
    const imageEditor = model({
      id: "brick_nano_banana_2",
      label: "Nano Banana 2",
      category: "image",
      backendCategory: "image_editing",
      workflowPath: "C:\\Momi-Animation\\workflow\\image_editing\\Brick_Nano Banana 2.json",
    });
    render(<ModelSelector models={[imageEditor]} selectedModel={imageEditor} onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Flux 3" })).toBeDisabled();
  });
});
