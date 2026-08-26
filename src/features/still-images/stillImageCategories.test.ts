import { describe, expect, it } from "vitest";

import {
  getStillImageCategory,
  STILL_IMAGE_CATEGORIES,
  shouldShowStillImagePrompt,
  stillImageSlotCount,
  visibleStillImageSettings,
  type StillImageCategoryId,
  type StillImageCategoryState,
  type StillImageSettingValue,
} from "./stillImageCategories";

// The same cases are asserted in backend/src/stillImageCategories.test.ts against
// the server's reading of the catalogue. The table itself is now shared -- both
// sides read backend/src/data/stillImagePresets.json -- so what these two suites
// still guard is the part that cannot be shared: the slot, prompt and visibility
// rules, which are code and are mirrored. If one side's rule changes alone, one of
// the two suites fails.
//
// Keep the tables below in the same order as the backend copy so a diff between
// the two files reads cleanly.

type Settings = Record<string, StillImageSettingValue>;

function state(settings: Settings): StillImageCategoryState {
  return { images: [], prompt: "", seed: "", settings };
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
  // Source, painted mask, and the marked guide unless the wash is off. Nothing
  // varies with the source image, so the only case is the toggle.
  ["image-editing", {}, 3],
  ["image-editing", { markRegion: true }, 3],
  ["image-editing", { markRegion: false }, 2],
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
  ["image-editing", {}, true],
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
  ["image-editing", {}, ["resolution", "thinking", "markRegion", "preserveUnmasked", "variations"]],
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
  const categoryIds: StillImageCategoryId[] = STILL_IMAGE_CATEGORIES.map((category) => category.id);

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

// The wording lives here and the data lives in the shared table, so the merge is
// where the two can disagree. A missing label would otherwise ship a control
// reading "faceDenoise", or a dropdown offering "raw-enhancement".
describe("the shared preset table", () => {
  it("gives every preset, setting and option its UI wording", () => {
    for (const category of STILL_IMAGE_CATEGORIES) {
      expect(category.label).toBeTruthy();
      expect(category.shortDescription).toBeTruthy();
      expect(category.instructions).toBeTruthy();
      for (const setting of category.settings) {
        expect(setting.label, `${category.id}.${setting.id}`).toBeTruthy();
        for (const option of setting.options ?? []) {
          expect(option.label, `${category.id}.${setting.id}.${option.value}`).toBeTruthy();
          // The value is what the server validates against, so wording may never
          // replace it.
          expect(option.value).toBeTruthy();
        }
      }
    }
  });

  it("takes bounds and defaults from the table rather than restating them", () => {
    // Spot-checked against stillImagePresets.json: these are the values the server
    // enforces, and reading them from the same file is the whole point.
    const details = getStillImageCategory("general-enhancement").settings.find((setting) => setting.id === "details");
    expect(details).toMatchObject({ kind: "range", defaultValue: 1, minimum: 0, maximum: 2, step: 0.05 });

    const upscale = getStillImageCategory("pro-upscaler").settings.find((setting) => setting.id === "upscale");
    expect(upscale?.options?.map((option) => option.value)).toEqual(["x2", "x4"]);
    expect(upscale?.options?.map((option) => option.label)).toEqual(["2x", "4x"]);
  });

  it("offers a prompt field only where the preset accepts one", () => {
    // acceptsPrompt in the shared table decides this, and the server rejects a
    // prompt on a preset that does not take one -- so a field drawn here that the
    // table forbids would be a 400 the artist only meets at Generate.
    expect(getStillImageCategory("general-enhancement").prompt).toBeDefined();
    expect(getStillImageCategory("qwen-edit").prompt).toBeDefined();
    expect(getStillImageCategory("pro-upscaler").prompt).toBeUndefined();
    expect(getStillImageCategory("reference-generator").prompt).toBeUndefined();
  });
});
