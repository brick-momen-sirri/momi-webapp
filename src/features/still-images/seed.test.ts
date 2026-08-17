import { describe, expect, it } from "vitest";

import { normalizeStillImageSeedInput, STILL_IMAGE_MAX_SEED, submittableStillImageSeed } from "./seed";

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
