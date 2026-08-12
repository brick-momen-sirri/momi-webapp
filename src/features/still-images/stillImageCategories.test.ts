import { describe, expect, it } from "vitest";

import {
  getStillImageCategory,
  shouldShowStillImagePrompt,
  stillImageSlotCount,
  visibleStillImageSettings,
  type StillImageCategoryId,
  type StillImageCategoryState,
  type StillImageSettingValue,
} from "./stillImageCategories";

// The same cases are asserted in backend/src/stillImageCategories.test.ts against
// the server's copy of this catalogue. These two files are the drift alarm for a
// pair that cannot share a module: if a range bound, an option value, a slot rule
// or a prompt rule changes on one side only, one of the two suites fails.
//
// Keep the tables below in the same order as the backend copy so a diff between
// the two files reads cleanly.

type Settings = Record<string, StillImageSettingValue>;

function state(settings: Settings): StillImageCategoryState {
  return { images: [], prompt: "", settings };
}

const slotCases: Array<[StillImageCategoryId, Settings, number]> = [
  ["general-enhancement", {}, 1],
  ["pro-upscaler", {}, 1],
  ["reference-generator", {}, 2],
  ["qwen-edit", {}, 1],
  ["qwen-edit", { mode: "edit", imageCount: "1" }, 1],
  ["qwen-edit", { mode: "edit", imageCount: "2" }, 2],
  ["qwen-edit", { mode: "edit", imageCount: "3" }, 3],
  ["qwen-edit", { mode: "reference-transfer", imageCount: "3" }, 2],
  ["qwen-edit", { mode: "consistency", imageCount: "3" }, 1],
  ["qwen-edit", { mode: "raw-enhancement", imageCount: "3" }, 1],
  ["qwen-edit", { mode: "edit", imageCount: "9" }, 3],
  ["qwen-edit", { mode: "edit", imageCount: "0" }, 1],
  ["qwen-edit", { mode: "edit", imageCount: "not-a-number" }, 1],
];

const promptCases: Array<[StillImageCategoryId, Settings, boolean]> = [
  ["general-enhancement", {}, true],
  ["pro-upscaler", {}, false],
  ["reference-generator", {}, false],
  ["qwen-edit", { mode: "edit" }, true],
  ["qwen-edit", { mode: "reference-transfer" }, false],
  ["qwen-edit", { mode: "consistency" }, true],
  ["qwen-edit", { mode: "raw-enhancement" }, true],
  ["qwen-edit", {}, true],
];

const visibilityCases: Array<[StillImageCategoryId, Settings, string[]]> = [
  [
    "general-enhancement",
    { generalEnhance: true, advancedDetails: false, bodyEnhance: false },
    ["generalEnhance", "details", "generalDenoise", "advancedDetails", "bodyEnhance"],
  ],
  [
    "general-enhancement",
    { generalEnhance: false, advancedDetails: false, bodyEnhance: false },
    ["generalEnhance", "details", "advancedDetails", "bodyEnhance"],
  ],
  [
    "general-enhancement",
    { generalEnhance: true, advancedDetails: true, bodyEnhance: false },
    ["generalEnhance", "details", "generalDenoise", "advancedDetails", "detailPass", "sharpen", "bodyEnhance"],
  ],
  [
    "general-enhancement",
    { generalEnhance: false, advancedDetails: false, bodyEnhance: true },
    ["generalEnhance", "details", "advancedDetails", "bodyEnhance", "bodyDenoise", "faceDenoise"],
  ],
  [
    // All three branches on: the case 7 row of forge's routing matrix.
    "general-enhancement",
    { generalEnhance: true, advancedDetails: true, bodyEnhance: true },
    [
      "generalEnhance",
      "details",
      "generalDenoise",
      "advancedDetails",
      "detailPass",
      "sharpen",
      "bodyEnhance",
      "bodyDenoise",
      "faceDenoise",
    ],
  ],
  ["pro-upscaler", { enhancement: true }, ["engine", "upscale", "enhancement", "creativity"]],
  ["pro-upscaler", { enhancement: false }, ["engine", "upscale", "enhancement"]],
  [
    "reference-generator",
    { enhancement: true },
    ["colorStrength", "creativity", "structureStrength", "enhancement", "colorMatch"],
  ],
  ["reference-generator", { enhancement: false }, ["colorStrength", "creativity", "structureStrength", "enhancement"]],
  ["qwen-edit", { mode: "edit" }, ["mode", "imageCount"]],
  ["qwen-edit", { mode: "consistency" }, ["mode"]],
];

describe("still image catalogue truth tables", () => {
  it("slot count truth table", () => {
    for (const [categoryId, settings, expected] of slotCases) {
      const actual = stillImageSlotCount(getStillImageCategory(categoryId), state(settings));
      expect(actual, `${categoryId} ${JSON.stringify(settings)}`).toBe(expected);
    }
  });

  it("prompt visibility truth table", () => {
    for (const [categoryId, settings, expected] of promptCases) {
      const actual = shouldShowStillImagePrompt(getStillImageCategory(categoryId), state(settings));
      expect(actual, `${categoryId} ${JSON.stringify(settings)}`).toBe(expected);
    }
  });

  it("setting visibility truth table", () => {
    for (const [categoryId, settings, expected] of visibilityCases) {
      const actual = visibleStillImageSettings(getStillImageCategory(categoryId), state(settings)).map((setting) => setting.id);
      expect(actual, `${categoryId} ${JSON.stringify(settings)}`).toEqual(expected);
    }
  });
});

describe("still image catalogue shape", () => {
  // These mirror the backend's assertions about its own copy. The server leans on
  // them when validating: a range without a maximum validates against Infinity,
  // and a select without options rejects every value including its own default.
  const categoryIds: StillImageCategoryId[] = ["general-enhancement", "pro-upscaler", "reference-generator", "qwen-edit"];

  it("every range setting has both bounds and a default inside them", () => {
    for (const categoryId of categoryIds) {
      for (const setting of getStillImageCategory(categoryId).settings) {
        if (setting.kind !== "range") continue;
        const where = `${categoryId}.${setting.id}`;
        expect(typeof setting.minimum, `${where} minimum`).toBe("number");
        expect(typeof setting.maximum, `${where} maximum`).toBe("number");
        expect(typeof setting.defaultValue, `${where} default`).toBe("number");
        expect(setting.defaultValue as number, `${where} default within bounds`).toBeGreaterThanOrEqual(setting.minimum!);
        expect(setting.defaultValue as number, `${where} default within bounds`).toBeLessThanOrEqual(setting.maximum!);
      }
    }
  });

  it("every select has options that include its default", () => {
    for (const categoryId of categoryIds) {
      for (const setting of getStillImageCategory(categoryId).settings) {
        if (setting.kind !== "select") continue;
        const where = `${categoryId}.${setting.id}`;
        const values = (setting.options ?? []).map((option) => option.value);
        expect(values.length, `${where} options`).toBeGreaterThan(0);
        expect(values, `${where} default is an option`).toContain(String(setting.defaultValue));
      }
    }
  });

  it("every checkbox defaults to a boolean", () => {
    for (const categoryId of categoryIds) {
      for (const setting of getStillImageCategory(categoryId).settings) {
        if (setting.kind !== "checkbox") continue;
        expect(typeof setting.defaultValue, `${categoryId}.${setting.id} default`).toBe("boolean");
      }
    }
  });

  it("a visibleWhen points at a setting that exists in the same category", () => {
    // A dangling reference silently hides the setting forever, on both sides.
    for (const categoryId of categoryIds) {
      const category = getStillImageCategory(categoryId);
      const ids = new Set(category.settings.map((setting) => setting.id));
      for (const setting of category.settings) {
        if (!setting.visibleWhen) continue;
        expect(ids, `${categoryId}.${setting.id} visibleWhen`).toContain(setting.visibleWhen.settingId);
      }
    }
  });
});
