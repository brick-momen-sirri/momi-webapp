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

  it("offers 2.0, 2.5 and 2.5 Draft when a Seedance workflow is selected", () => {
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
    expect(screen.getByRole("radio", { name: /Seedance 2\.5(?! Draft)/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /Seedance 2\.5 Draft/ })).not.toBeChecked();
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

    await userEvent.click(screen.getByRole("radio", { name: /Seedance 2\.5(?! Draft)/ }));
    expect(onSeedanceVersionChange).toHaveBeenCalledWith("2.5");
    await userEvent.click(screen.getByRole("radio", { name: /Seedance 2\.5 Draft/ }));
    expect(onSeedanceVersionChange).toHaveBeenCalledWith("2.5-draft");
  });
});

describe("partner model families", () => {
  const nano2 = model({
    id: "brick_nano_banana_2",
    label: "Nano Banana 2",
    backendCategory: "image_editing",
    category: "image",
    workflowPath: "C:/Momi-Animation/workflow/image_editing/Brick_Nano Banana 2.json",
  });
  const nanoPro = model({
    id: "brick_nano_banana_pro",
    label: "Nano Banana Pro",
    backendCategory: "image_editing",
    category: "image",
    workflowPath: "C:/Momi-Animation/workflow/image_editing/Brick_Nano Banana Pro.json",
  });
  const seedreamPro = model({
    id: "brick_api_seedream_5_0_pro",
    label: "Seedream 5.0 Pro",
    backendCategory: "image_editing",
    category: "image",
    workflowPath: "C:/Momi-Animation/workflow/image_editing/Brick_api_seedream_5_0_pro.json",
  });
  const seedreamFlash = model({
    id: "brick_api_seedream_5_0_flash",
    label: "Seedream 5.0 Flash",
    backendCategory: "image_editing",
    category: "image",
    workflowPath: "C:/Momi-Animation/workflow/image_editing/Brick_api_seedream_5_0_flash.json",
  });

  it("shows one card per family and a labelled version picker for its members", async () => {
    const onChange = vi.fn();
    render(
      <ModelSelector
        models={[nano2, nanoPro, seedreamPro, seedreamFlash]}
        selectedModel={seedreamPro}
        seedanceVersion="2.0"
        onChange={onChange}
        onSeedanceVersionChange={vi.fn()}
      />,
    );

    // Two families, two cards -- not four identical icons.
    expect(screen.getByRole("button", { name: "Nano Banana" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Seedream 5.0" })).toHaveAttribute("aria-pressed", "true");
    const versions = screen.getByRole("radiogroup", { name: "Seedream 5.0 version" });
    expect(versions).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Seedream 5\.0 Pro.*Best quality/ })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: /Seedream 5\.0 Flash.*Fastest and cheapest/ }));
    expect(onChange).toHaveBeenCalledWith("brick_api_seedream_5_0_flash");
  });

  it("opens a family on its declared default", async () => {
    const onChange = vi.fn();
    render(
      <ModelSelector
        models={[nano2, nanoPro, seedreamPro, seedreamFlash]}
        selectedModel={seedreamFlash}
        seedanceVersion="2.0"
        onChange={onChange}
        onSeedanceVersionChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Nano Banana" }));
    expect(onChange).toHaveBeenCalledWith("brick_nano_banana_2");
  });
});

describe("Video Enhancer task", () => {
  const enhancer = model({
    id: "video_enhancer_ltx25_cq",
    label: "Video Enhancer",
    backendCategory: "video_upscaling",
    workflowPath: "C:/Momi-Animation/backend/workflow-video-enhancer/ltx25-cq-v2.json",
    requiresImage: false,
    requiresVideo: true,
    imageSlotCount: 0,
  });

  it("opens the enhancer from its own tab", async () => {
    const flux = model();
    const onChange = vi.fn();
    render(
      <ModelSelector
        models={[flux, enhancer]}
        selectedModel={flux}
        seedanceVersion="2.0"
        onChange={onChange}
        onSeedanceVersionChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /Video Enhancer/ }));
    expect(onChange).toHaveBeenCalledWith("video_enhancer_ltx25_cq");
  });

  it("offers only the enhancer, without the Flux placeholder", () => {
    render(
      <ModelSelector
        models={[enhancer]}
        selectedModel={enhancer}
        seedanceVersion="2.0"
        onChange={vi.fn()}
        onSeedanceVersionChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Video Enhancer" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Flux 3" })).toBeNull();
  });

  it("is disabled where no enhancer endpoint is configured", () => {
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

    expect(screen.getByRole("button", { name: /Video Enhancer/ })).toBeDisabled();
  });
});

describe("LTX 2.5 CQ image to video", () => {
  const kling = model({
    id: "brick_api_kling_v3_video",
    label: "Kling v3 Video",
    workflowPath: "C:/Momi-Animation/workflow/i2v/Brick_api_kling_v3_video.json",
  });
  const ltx = model({
    id: "ltx25_cq_i2v",
    label: "LTX 2.5 CQ Image to Video",
    workflowPath: "C:/Momi-Animation/backend/workflow-ltx-cq-i2v/ltx25-cq-i2v.json",
  });

  it("joins the providers in Image to Video", async () => {
    const onChange = vi.fn();
    render(
      <ModelSelector
        models={[kling, ltx]}
        selectedModel={kling}
        seedanceVersion="2.0"
        onChange={onChange}
        onSeedanceVersionChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "LTX 2.5 CQ" }));
    expect(onChange).toHaveBeenCalledWith("ltx25_cq_i2v");
    expect(screen.getByRole("button", { name: "Kling" })).toBeEnabled();
  });

  it("offers First & Last Frame in Frame to Video, labelled experimental", async () => {
    const kling = model({
      id: "brick_api_kling_v3_flf2v",
      label: "Kling v3 flf2v",
      backendCategory: "first_last_frame_to_video",
      workflowPath: "C:/Momi-Animation/workflow/flf2v/Brick_api_kling_v3_flf2v.json",
    });
    const flf = model({
      id: "ltx25_cq_flf2v",
      label: "LTX 2.5 CQ First & Last Frame (Experimental)",
      description: "Experimental. The frames in between can bend or distort architecture -- exact geometry is not preserved.",
      backendCategory: "first_last_frame_to_video",
      workflowPath: "C:/Momi-Animation/backend/workflow-ltx-cq-i2v/ltx25-cq-flf.json",
    });
    const onChange = vi.fn();
    const { rerender } = render(
      <ModelSelector
        models={[kling, flf, ltx]}
        selectedModel={kling}
        seedanceVersion="2.0"
        onChange={onChange}
        onSeedanceVersionChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "LTX 2.5 CQ" }));
    expect(onChange).toHaveBeenCalledWith("ltx25_cq_flf2v");

    rerender(
      <ModelSelector
        models={[kling, flf, ltx]}
        selectedModel={flf}
        seedanceVersion="2.0"
        onChange={onChange}
        onSeedanceVersionChange={vi.fn()}
      />,
    );
    expect(screen.getByText("LTX 2.5 CQ First & Last Frame (Experimental)")).toBeInTheDocument();
    expect(screen.getByText(/exact geometry is not preserved/)).toBeInTheDocument();
  });

  it("does not appear, even disabled, where it has no model", () => {
    const firstLast = model({
      id: "brick_api_kling_v3_flf2v",
      label: "Kling v3 flf2v",
      backendCategory: "first_last_frame_to_video",
      workflowPath: "C:/Momi-Animation/workflow/flf2v/Brick_api_kling_v3_flf2v.json",
    });
    render(
      <ModelSelector
        models={[firstLast, ltx]}
        selectedModel={firstLast}
        seedanceVersion="2.0"
        onChange={vi.fn()}
        onSeedanceVersionChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "LTX 2.5 CQ" })).toBeNull();
    expect(screen.getByRole("button", { name: "Kling" })).toBeEnabled();
  });
});
