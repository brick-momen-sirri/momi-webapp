import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

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
});

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
