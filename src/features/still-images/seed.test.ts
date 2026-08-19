import { describe, expect, it } from "vitest";

import {
  normalizeStillImageSeedInput,
  randomStillImageSeedValue,
  stepStillImageSeed,
  STILL_IMAGE_MAX_SEED,
  submittableStillImageSeed,
} from "./seed";

// The bound is duplicated from backend/src/stillImageSeed.ts, which is what
// actually rejects a seed. Its own test asserts the same number; if one side moves
// alone, the form starts offering values the server refuses at submission time --
// after the artist has set everything else up.
describe("the seed bound matches the server", () => {
  it("is 2^32-1", () => {
    expect(STILL_IMAGE_MAX_SEED).toBe(4_294_967_295);
  });
});

describe("normalizeStillImageSeedInput", () => {
  it("keeps a plain seed", () => {
    expect(normalizeStillImageSeedInput("12345")).toBe("12345");
  });

  it("drops anything that is not a digit", () => {
    // Seeds get pasted out of the card's metadata row and out of chat messages.
    expect(normalizeStillImageSeedInput("Seed 1 234-567")).toBe("1234567");
    expect(normalizeStillImageSeedInput("-42")).toBe("42");
    expect(normalizeStillImageSeedInput("1.5")).toBe("15");
  });

  it("clamps above the maximum instead of letting the server refuse it", () => {
    expect(normalizeStillImageSeedInput("99999999999")).toBe(String(STILL_IMAGE_MAX_SEED));
  });

  it("strips leading zeros but keeps zero itself", () => {
    expect(normalizeStillImageSeedInput("007")).toBe("7");
    expect(normalizeStillImageSeedInput("0")).toBe("0");
  });

  it("treats an empty field as empty", () => {
    expect(normalizeStillImageSeedInput("")).toBe("");
    expect(normalizeStillImageSeedInput("abc")).toBe("");
  });
});

describe("submittableStillImageSeed", () => {
  it("sends nothing when the field is empty, so the server mints one", () => {
    expect(submittableStillImageSeed("")).toBeUndefined();
  });

  it("sends seed zero rather than dropping it", () => {
    // Falsy but valid, and the one seed someone is most likely to type by hand.
    expect(submittableStillImageSeed("0")).toBe(0);
  });

  it("sends a number, not the typed string", () => {
    expect(submittableStillImageSeed("4242")).toBe(4242);
  });
});

describe("stepStillImageSeed", () => {
  it("walks to the neighbouring seed", () => {
    expect(stepStillImageSeed("1234", 1)).toBe("1235");
    expect(stepStillImageSeed("1234", -1)).toBe("1233");
  });

  it("stays inside the range the server accepts", () => {
    // Both ends are real seeds, so they are clamped to rather than refused.
    expect(stepStillImageSeed("0", -1)).toBe("0");
    expect(stepStillImageSeed(String(STILL_IMAGE_MAX_SEED), 1)).toBe(String(STILL_IMAGE_MAX_SEED));
  });

  it("leaves an empty field empty", () => {
    // There is nothing to step from, and picking a base would pin a seed nobody chose
    // -- turning "draw one for me" into a fixed render without the artist asking.
    expect(stepStillImageSeed("", 1)).toBe("");
    expect(stepStillImageSeed("", -1)).toBe("");
  });

  it("steps from what the field would normalise to, not the raw text", () => {
    expect(stepStillImageSeed("Seed 41", 1)).toBe("42");
  });
});

describe("randomStillImageSeedValue", () => {
  it("draws a seed the server will accept", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const drawn = randomStillImageSeedValue();
      expect(drawn).toMatch(/^\d+$/);
      expect(Number(drawn)).toBeGreaterThanOrEqual(0);
      expect(Number(drawn)).toBeLessThanOrEqual(STILL_IMAGE_MAX_SEED);
    }
  });

  it("survives the field's own normalisation unchanged", () => {
    // A drawn seed goes through setSeed like a typed one. If it came back different
    // the field would show something other than what will be submitted.
    const drawn = randomStillImageSeedValue();
    expect(normalizeStillImageSeedInput(drawn)).toBe(drawn);
  });
});
