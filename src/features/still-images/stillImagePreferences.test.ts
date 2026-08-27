import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import type { Job } from "../../types";
import { appendMaskStroke, createMaskDrawing } from "./maskDrawing";
import { DEFAULT_STILL_IMAGE_RESULT_FILTERS } from "./resultFilters";
import { createInitialStillImagesState } from "./stillImageCategories";
import {
  readPersistedStillImageResultView,
  readPersistedStillImagesForm,
  writePersistedStillImageResultView,
  writePersistedStillImagesForm,
} from "./stillImagePreferences";
import { useStillImagesForm } from "./useStillImagesForm";

// What is being protected here is a reload, and the two things that make a restored
// panel worse than a blank one: a setting the catalogue no longer accepts, which the
// server refuses at Generate, and an input slot that looks filled but points at bytes
// the browser released with the tab.

const FORM_KEY = "momi_still_images_form_v1";
const RESULT_VIEW_KEY = "momi_still_images_results_v1";

beforeEach(() => {
  window.localStorage.clear();
});

function storeForm(value: unknown) {
  window.localStorage.setItem(FORM_KEY, JSON.stringify(value));
}

describe("the still images form across a reload", () => {
  it("starts from the catalogue defaults with nothing stored", () => {
    const restored = readPersistedStillImagesForm();
    expect(restored.selectedCategoryId).toBe("general-enhancement");
    expect(restored.saveNumber).toBe("0000");
    expect(restored.targetFolderId).toBe("");
    expect(restored.stateByCategory).toEqual(createInitialStillImagesState());
  });

  it("brings back every preset's fields, not just the visible one's", () => {
    // Switching preset and back was one of the ways this state was being lost, so the
    // whole catalogue is written rather than the selected entry.
    const state = createInitialStillImagesState();
    state["qwen-edit"] = { ...state["qwen-edit"], prompt: "replace the sky", seed: "4242" };
    state["pro-upscaler"] = {
      ...state["pro-upscaler"],
      settings: { ...state["pro-upscaler"].settings, upscale: "x4", creativity: 40 },
    };
    writePersistedStillImagesForm({
      selectedCategoryId: "pro-upscaler",
      stateByCategory: state,
      targetFolderId: "fld_9",
      saveNumber: "12",
    });

    const restored = readPersistedStillImagesForm();
    expect(restored.selectedCategoryId).toBe("pro-upscaler");
    expect(restored.targetFolderId).toBe("fld_9");
    // Normalised on the way in, the same as the field itself does.
    expect(restored.saveNumber).toBe("0012");
    expect(restored.stateByCategory["qwen-edit"].prompt).toBe("replace the sky");
    expect(restored.stateByCategory["qwen-edit"].seed).toBe("4242");
    expect(restored.stateByCategory["pro-upscaler"].settings.upscale).toBe("x4");
    expect(restored.stateByCategory["pro-upscaler"].settings.creativity).toBe(40);
  });

  it("never stores or restores an input image", () => {
    // An uploaded file is a blob URL that dies with the tab. A slot restored from one
    // would look filled while pointing at nothing, and the panel would offer Generate.
    const state = createInitialStillImagesState();
    state["general-enhancement"] = {
      ...state["general-enhancement"],
      images: [{ id: "img_1", name: "plate.png", url: "blob:http://localhost/abc", cropRequired: false }],
    };
    writePersistedStillImagesForm({
      selectedCategoryId: "general-enhancement",
      stateByCategory: state,
      targetFolderId: "",
      saveNumber: "0000",
    });

    expect(window.localStorage.getItem(FORM_KEY)).not.toContain("blob:");
    expect(readPersistedStillImagesForm().stateByCategory["general-enhancement"].images).toEqual([]);
  });

  it("replaces a setting the catalogue no longer accepts with its default", () => {
    // Written by a build whose range was wider, or hand-edited. Restored as-is it sits
    // in the panel until Generate, where the server rejects the whole submission.
    storeForm({
      selectedCategoryId: "general-enhancement",
      categories: {
        "general-enhancement": { prompt: "keep", seed: "5", settings: { generalDenoise: 9, generalEnhance: "yes" } },
        "pro-upscaler": { settings: { upscale: "x8" } },
      },
    });

    const restored = readPersistedStillImagesForm();
    const general = restored.stateByCategory["general-enhancement"];
    expect(general.prompt).toBe("keep");
    expect(general.seed).toBe("5");
    // 9 is past the 0.45 ceiling and "yes" is not a boolean.
    expect(general.settings.generalDenoise).toBe(0.1);
    expect(general.settings.generalEnhance).toBe(true);
    expect(restored.stateByCategory["pro-upscaler"].settings.upscale).toBe("x2");
  });

  it("falls back on a stored preset id that no longer exists", () => {
    storeForm({ selectedCategoryId: "flux-something-removed" });
    expect(readPersistedStillImagesForm().selectedCategoryId).toBe("general-enhancement");
  });

  it("treats unreadable storage as none", () => {
    window.localStorage.setItem(FORM_KEY, "{not json");
    expect(readPersistedStillImagesForm().stateByCategory).toEqual(createInitialStillImagesState());
  });

  it("clamps a stored seed to what the server accepts", () => {
    storeForm({ categories: { "qwen-edit": { seed: "99999999999" } } });
    expect(readPersistedStillImagesForm().stateByCategory["qwen-edit"].seed).toBe("4294967295");
  });
});

describe("useStillImagesForm", () => {
  it("holds the prompt, seed and sliders across a remount", () => {
    const first = renderHook(() => useStillImagesForm());
    act(() => {
      first.result.current.setPrompt("preserve stone texture");
      first.result.current.setSeed("1234");
      first.result.current.setSaveNumber("12");
      first.result.current.setSetting("details", 1.5);
    });
    first.unmount();

    // What a refresh, or a trip to Animation and back, does to this panel.
    const second = renderHook(() => useStillImagesForm());
    expect(second.result.current.selectedState.prompt).toBe("preserve stone texture");
    expect(second.result.current.selectedState.seed).toBe("1234");
    expect(second.result.current.selectedState.settings.details).toBe(1.5);
    expect(second.result.current.saveNumber).toBe("0012");
  });

  it("comes back on the preset that was selected", () => {
    const first = renderHook(() => useStillImagesForm());
    act(() => first.result.current.setSelectedCategoryId("reference-generator"));
    first.unmount();

    expect(renderHook(() => useStillImagesForm()).result.current.selectedCategoryId).toBe("reference-generator");
  });

  it("keeps a completed layer but resets the editor for the next mask", () => {
    const form = renderHook(() => useStillImagesForm());
    const mask = appendMaskStroke(createMaskDrawing(1200, 800), {
      tool: "brush",
      radius: 40,
      points: [{ x: 300, y: 250 }],
    });

    act(() => form.result.current.setSelectedCategoryId("image-editing"));
    act(() => {
      form.result.current.setImages([{ id: "source", name: "source.png", url: "blob:source" }]);
      form.result.current.setMask(mask);
      form.result.current.setPrompt("replace the chair");
      form.result.current.setEditReferences([{ id: "ref", name: "reference.png", url: "blob:reference" }]);
    });
    act(() => form.result.current.commitEditLayer(completedEditJob("/api/media?path=generated-v1.png")));

    expect(form.result.current.selectedState).toMatchObject({
      activeEditLayerId: undefined,
      mask: undefined,
      prompt: "",
      editReferences: [],
    });
    expect(form.result.current.selectedState.editLayers).toHaveLength(1);
    expect(form.result.current.selectedState.editLayers?.[0]).toMatchObject({
      id: "edit_layer_1",
      prompt: "replace the chair",
      visible: true,
      status: "completed",
      generatedCropSourceUrl: "/api/media?path=generated-v1.png",
    });
  });

  it("resets to a new draft after regenerating without duplicating the layer", () => {
    const form = renderHook(() => useStillImagesForm());
    act(() => form.result.current.setSelectedCategoryId("image-editing"));
    act(() => form.result.current.commitEditLayer(completedEditJob("/api/media?path=generated-v1.png")));
    act(() => form.result.current.selectEditLayer("edit_layer_1"));
    expect(form.result.current.selectedState.activeEditLayerId).toBe("edit_layer_1");

    act(() => form.result.current.commitEditLayer(completedEditJob("/api/media?path=generated-v2.png", "regenerate")));

    expect(form.result.current.selectedState.editLayers).toHaveLength(1);
    expect(form.result.current.selectedState.editLayers?.[0]?.generatedCropSourceUrl).toBe("/api/media?path=generated-v2.png");
    expect(form.result.current.selectedState).toMatchObject({
      activeEditLayerId: undefined,
      mask: undefined,
      prompt: "",
      editReferences: [],
    });
  });

  it("arms the layer's pixels on selection and its mask only when the mask is asked for", () => {
    const form = renderHook(() => useStillImagesForm());
    act(() => form.result.current.setSelectedCategoryId("image-editing"));
    act(() => form.result.current.commitEditLayer(completedEditJob("/api/media?path=generated-v1.png")));

    act(() => form.result.current.selectEditLayer("edit_layer_1"));
    expect(form.result.current.selectedState.editTarget).toBe("content");

    act(() => form.result.current.selectEditLayer("edit_layer_1", "mask"));
    expect(form.result.current.selectedState.editTarget).toBe("mask");

    act(() => form.result.current.setEditTarget("content"));
    expect(form.result.current.selectedState.editTarget).toBe("content");
  });

  it("keeps opacity and the mask switch across a regeneration", () => {
    const form = renderHook(() => useStillImagesForm());
    act(() => form.result.current.setSelectedCategoryId("image-editing"));
    act(() => form.result.current.commitEditLayer(completedEditJob("/api/media?path=generated-v1.png")));
    act(() => {
      form.result.current.setEditLayerOpacity("edit_layer_1", 35);
      form.result.current.setEditLayerMaskEnabled("edit_layer_1", false);
    });
    act(() => form.result.current.selectEditLayer("edit_layer_1"));
    act(() => form.result.current.commitEditLayer(completedEditJob("/api/media?path=generated-v2.png", "regenerate")));

    // The new take replaces the pixels; how the artist had set the layer up is a
    // property of the layer and survives.
    expect(form.result.current.selectedState.editLayers?.[0]).toMatchObject({
      generatedCropSourceUrl: "/api/media?path=generated-v2.png",
      opacity: 35,
      maskEnabled: false,
    });
  });

  it("moves an unchained mask in the session draft as well as on the layer", () => {
    const form = renderHook(() => useStillImagesForm());
    act(() => form.result.current.setSelectedCategoryId("image-editing"));
    act(() => form.result.current.commitEditLayer(completedEditJob("/api/media?path=generated-v1.png")));
    act(() => form.result.current.selectEditLayer("edit_layer_1", "mask"));
    act(() => form.result.current.setEditLayerMaskLinked("edit_layer_1", false));
    act(() => form.result.current.moveEditLayerBy("edit_layer_1", "mask", { x: 40, y: -10 }));

    const layer = form.result.current.selectedState.editLayers?.[0];
    expect(layer?.mask.strokes[0].points).toEqual([{ x: 340, y: 240 }]);
    // The editor is holding the same drawing, so it has to move with it or the
    // next stroke lands against the position the mask used to be in.
    expect(form.result.current.selectedState.mask).toBe(layer?.mask);
  });

  it("moves the whole layer, mask included, while the chain is on", () => {
    const form = renderHook(() => useStillImagesForm());
    act(() => form.result.current.setSelectedCategoryId("image-editing"));
    act(() => form.result.current.commitEditLayer(completedEditJob("/api/media?path=generated-v1.png")));
    act(() => form.result.current.selectEditLayer("edit_layer_1", "content"));
    act(() => form.result.current.moveEditLayerBy("edit_layer_1", "content", { x: 12, y: 8 }));

    const layer = form.result.current.selectedState.editLayers?.[0];
    expect(layer?.offset).toEqual({ x: 12, y: 8 });
    expect(layer?.mask.strokes[0].points).toEqual([{ x: 300, y: 250 }]);
  });

  it("duplicates a layer above its source without touching the selection", () => {
    const form = renderHook(() => useStillImagesForm());
    act(() => form.result.current.setSelectedCategoryId("image-editing"));
    act(() => form.result.current.commitEditLayer(completedEditJob("/api/media?path=generated-v1.png")));
    act(() => form.result.current.duplicateEditLayer("edit_layer_1"));

    const layers = form.result.current.selectedState.editLayers ?? [];
    expect(layers).toHaveLength(2);
    expect(layers[1].name).toBe("Edit Layer 01 copy");
    expect(layers[1].id).not.toBe("edit_layer_1");
    expect(layers[1].generatedCropSourceUrl).toBe("/api/media?path=generated-v1.png");
  });
});

function completedEditJob(generatedCropUrl: string, operation: "create" | "regenerate" = "create"): Job {
  return {
    id: `job_${operation}`,
    projectId: "prj_1",
    userId: "usr_1",
    modelType: "Image Editing",
    inputType: "multi_image",
    prompt: "replace the chair",
    resolution: "Unknown",
    status: "completed",
    inputImages: [],
    resultUrl: `/api/jobs/job_${operation}/result-media?index=0`,
    resultSourceUrls: [generatedCropUrl],
    createdAt: "2026-08-27T08:00:00.000Z",
    completedAt: "2026-08-27T08:01:00.000Z",
    workflowOptions: {
      stillImage: {
        categoryId: "image-editing",
        settings: {},
        edit: {
          layerId: "edit_layer_1",
          operation,
          mode: "inpaint",
          documentId: "editdoc_12345678",
          crop: { x: 100, y: 50, size: 400, sourceWidth: 1200, sourceHeight: 800 },
          mask: appendMaskStroke(createMaskDrawing(1200, 800), {
            tool: "brush",
            radius: 40,
            points: [{ x: 300, y: 250 }],
          }),
          originalSourceUrl: "/api/media?path=original.png",
          maskSourceUrl: "/api/media?path=mask.png",
          baseLayerIds: [],
          baseLayers: [],
          referenceSourceUrls: [],
          generatedCropUrl,
        },
      },
    },
  };
}

describe("the results view across a reload", () => {
  it("starts unfiltered, in cards", () => {
    expect(readPersistedStillImageResultView()).toEqual({ filters: DEFAULT_STILL_IMAGE_RESULT_FILTERS, layout: "list" });
  });

  it("brings back how the list was narrowed and shaped", () => {
    writePersistedStillImageResultView({
      filters: {
        ...DEFAULT_STILL_IMAGE_RESULT_FILTERS,
        presetId: "pro-upscaler",
        status: "failed",
        folderId: "fld_3",
        favoritesOnly: true,
        mineOnly: true,
        sort: "cost",
      },
      layout: "grid",
    });

    const restored = readPersistedStillImageResultView();
    expect(restored.layout).toBe("grid");
    expect(restored.filters).toMatchObject({
      presetId: "pro-upscaler",
      status: "failed",
      folderId: "fld_3",
      favoritesOnly: true,
      mineOnly: true,
      sort: "cost",
    });
  });

  it("does not carry the search box across", () => {
    // A preset or a status is a standing way of working; a typed query is a one-off
    // lookup, and finding one still in the box tomorrow reads as missing results.
    writePersistedStillImageResultView({
      filters: { ...DEFAULT_STILL_IMAGE_RESULT_FILTERS, query: "cam-12", status: "completed" },
      layout: "list",
    });

    const restored = readPersistedStillImageResultView();
    expect(restored.filters.query).toBe("");
    expect(restored.filters.status).toBe("completed");
  });

  it("ignores stored values the panel has no control for", () => {
    window.localStorage.setItem(
      RESULT_VIEW_KEY,
      JSON.stringify({ filters: { presetId: "gone", status: "sideways", sort: "cheapest" }, layout: "carousel" }),
    );

    expect(readPersistedStillImageResultView()).toEqual({ filters: DEFAULT_STILL_IMAGE_RESULT_FILTERS, layout: "list" });
  });
});
