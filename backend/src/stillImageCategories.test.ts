import test from "node:test";
import assert from "node:assert/strict";

import {
  acceptsStillImagePrompt,
  getStillImageCategory,
  isStillImageCategoryId,
  stillImageSlotCount,
  visibleStillImageSettings,
  type StillImageCategoryId,
  type StillImageSettingValue,
} from "./stillImageCategories.js";

// The same cases are asserted in src/features/still-images/stillImageCategories.test.ts
// against the frontend catalogue. These two files are the drift alarm for a pair
// that cannot share a module: if a range bound, an option value, a slot rule or a
// prompt rule changes on one side only, one of the two suites fails.
//
// Keep the tables below in the same order as the frontend copy so a diff between
// the two files reads cleanly.

type Settings = Record<string, StillImageSettingValue>;

const slotCases: Array<[StillImageCategoryId, Settings, number]> = [
  ["general-enhancement", {}, 1],
  ["pro-upscaler", {}, 1],
  ["reference-generator", {}, 2],
  ["qwen-edit", {}, 1],
  ["qwen-edit", { mode: "edit", imageCount: "1" }, 1],
  ["qwen-edit", { mode: "edit", imageCount: "2" }, 2],
  ["qwen-edit", { mode: "edit", imageCount: "3" }, 3],
  // The mode wins over imageCount: reference transfer is always the pair.
  ["qwen-edit", { mode: "reference-transfer", imageCount: "3" }, 2],
  ["qwen-edit", { mode: "consistency", imageCount: "3" }, 1],
  ["qwen-edit", { mode: "raw-enhancement", imageCount: "3" }, 1],
  // Out-of-range and unparseable counts clamp rather than propagating a bad
  // slot count into the graph.
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

test("slot count truth table", () => {
  for (const [categoryId, settings, expected] of slotCases) {
    const actual = stillImageSlotCount(getStillImageCategory(categoryId), settings);
    assert.equal(actual, expected, `${categoryId} ${JSON.stringify(settings)} should take ${expected} image(s), got ${actual}`);
  }
});

test("prompt acceptance truth table", () => {
  for (const [categoryId, settings, expected] of promptCases) {
    const actual = acceptsStillImagePrompt(getStillImageCategory(categoryId), settings);
    assert.equal(actual, expected, `${categoryId} ${JSON.stringify(settings)} prompt acceptance should be ${expected}`);
  }
});

test("setting visibility truth table", () => {
  for (const [categoryId, settings, expected] of visibilityCases) {
    const actual = visibleStillImageSettings(getStillImageCategory(categoryId), settings).map((setting) => setting.id);
    assert.deepEqual(actual, expected, `${categoryId} ${JSON.stringify(settings)} visible settings`);
  }
});

test("isStillImageCategoryId accepts only the four presets", () => {
  assert.equal(isStillImageCategoryId("qwen-edit"), true);
  assert.equal(isStillImageCategoryId("general-enhancement"), true);
  assert.equal(isStillImageCategoryId("Qwen-Edit"), false);
  assert.equal(isStillImageCategoryId("image_editing"), false);
  assert.equal(isStillImageCategoryId(""), false);
  assert.equal(isStillImageCategoryId(undefined), false);
  assert.equal(isStillImageCategoryId({ categoryId: "qwen-edit" }), false);
});

test("getStillImageCategory throws rather than falling back to a preset", () => {
  // The frontend copy falls back to the first category so a bad id still renders
  // something. On this side a bad id means a request we cannot judge, and quietly
  // validating it against General Enhancement's ranges would be worse than a 400.
  assert.throws(() => getStillImageCategory("not-a-preset" as StillImageCategoryId), /Unknown still image category/);
});

test("every range setting has both bounds and every select has options", () => {
  // normalizeStillImageOptions leans on these being present: a range without a
  // maximum validates against Infinity, and a select without options rejects
  // every value including its own default.
  for (const categoryId of ["general-enhancement", "pro-upscaler", "reference-generator", "qwen-edit"] as const) {
    for (const setting of getStillImageCategory(categoryId).settings) {
      const where = `${categoryId}.${setting.id}`;
      if (setting.kind === "range") {
        assert.equal(typeof setting.minimum, "number", `${where} needs a minimum`);
        assert.equal(typeof setting.maximum, "number", `${where} needs a maximum`);
        assert.equal(typeof setting.defaultValue, "number", `${where} default must be a number`);
        assert.ok(
          (setting.defaultValue as number) >= setting.minimum! && (setting.defaultValue as number) <= setting.maximum!,
          `${where} default sits outside its own bounds`,
        );
      }
      if (setting.kind === "select") {
        assert.ok(setting.options?.length, `${where} needs options`);
        assert.ok(setting.options!.includes(String(setting.defaultValue)), `${where} default is not one of its options`);
      }
      if (setting.kind === "checkbox") {
        assert.equal(typeof setting.defaultValue, "boolean", `${where} default must be a boolean`);
      }
    }
  }
});
