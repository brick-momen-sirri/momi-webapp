import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    render(
      <ModelSelector
        models={[flux]}
        selectedModel={flux}
        seedanceVersion="2.0"
        onChange={vi.fn()}
        onSeedanceVersionChange={vi.fn()}
      />,
    );

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
    render(
      <ModelSelector
        models={[imageEditor]}
        selectedModel={imageEditor}
        seedanceVersion="2.0"
        onChange={vi.fn()}
        onSeedanceVersionChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Flux 3" })).toBeDisabled();
  });
});

describe("Seedance model version", () => {
  const seedance = model({
    id: "brick_api_seedance2_0_i2v",
    label: "Api Seedance2 0 I2v",
    workflowPath: "C:\\Momi-Animation\\workflow\\i2v\\Brick_api_seedance2_0_i2v .json",
  });

  it("offers 2.0 and 2.5 when a Seedance workflow is selected", () => {
    render(
      <ModelSelector
        models={[seedance]}
        selectedModel={seedance}
        seedanceVersion="2.0"
        onChange={vi.fn()}
        onSeedanceVersionChange={vi.fn()}
      />,
    );

    const group = screen.getByRole("radiogroup", { name: "Seedance model version" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Seedance 2\.0/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Seedance 2\.5/ })).not.toBeChecked();
  });

  it("stays out of the way for every other provider", () => {
    const flux = model();
    render(
      <ModelSelector
        models={[flux]}
        selectedModel={flux}
        seedanceVersion="2.0"
        onChange={vi.fn()}
        onSeedanceVersionChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("radiogroup", { name: "Seedance model version" })).toBeNull();
  });

  it("reports the version the artist picked", async () => {
    const onSeedanceVersionChange = vi.fn();
    render(
      <ModelSelector
        models={[seedance]}
        selectedModel={seedance}
        seedanceVersion="2.0"
        onChange={vi.fn()}
        onSeedanceVersionChange={onSeedanceVersionChange}
      />,
    );

    await userEvent.click(screen.getByRole("radio", { name: /Seedance 2\.5/ }));
    expect(onSeedanceVersionChange).toHaveBeenCalledWith("2.5");
  });
});
