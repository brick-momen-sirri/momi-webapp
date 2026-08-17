// The seed field, as the Still Images form needs it.
//
// The bound MUST stay in step with STILL_IMAGE_MAX_SEED in backend/src/stillImageSeed.ts,
// which is what actually rejects an out-of-range seed. Same arrangement as the
// preset catalogue next door: the pair cannot share a module, so both sides are
// asserted against the same number in their own tests.
//
// The server owns the drawing. This side only ever passes a seed back that it
// read off an earlier job, or leaves it out so a fresh one is minted -- so
// "reproduce that render" is the client's job and "make a new one" is not.

export const STILL_IMAGE_MAX_SEED = 4_294_967_295;

/**
 * What the seed field should hold after a keystroke.
 *
 * Digits only and clamped, so the field can never carry a value the server will
 * reject -- the alternative is an error only discovered after the artist has set
 * everything else up and pressed Generate.
 */
export function normalizeStillImageSeedInput(value: string) {
  const digits = value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  if (!digits) return "";
  const numeric = Number(digits);
  return String(Number.isFinite(numeric) && numeric > STILL_IMAGE_MAX_SEED ? STILL_IMAGE_MAX_SEED : numeric);
}

/**
 * The seed to submit, or undefined to let the server mint one.
 *
 * Empty is the normal case: an artist who has not asked for a particular seed
 * wants a new render, not a repeat of whatever was in the box.
 */
export function submittableStillImageSeed(value: string) {
  const normalized = normalizeStillImageSeedInput(value);
  return normalized ? Number(normalized) : undefined;
}
