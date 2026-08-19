// The seed field, as the Still Images form needs it.
//
// The bound MUST stay in step with STILL_IMAGE_MAX_SEED in backend/src/stillImageSeed.ts,
// which is what actually rejects an out-of-range seed. Same arrangement as the
// preset catalogue next door: the pair cannot share a module, so both sides are
// asserted against the same number in their own tests.
//
// The server still draws the seed for every run that does not name one, which is
// the normal path. This side names one in two cases: a seed read off an earlier
// job, to reproduce it, and a seed pinned here deliberately -- which needs a number
// in the field before Generate, not after the job comes back.

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

/**
 * A seed to pin, drawn on this side rather than by the server.
 *
 * For holding one number across a set of runs: pin it, and the renders differ only
 * by whatever slider is being explored. Leaving the field empty is still the way to
 * ask for a fresh render, and is still what most runs do.
 *
 * Math.random because the requirement is a different render, not an unguessable
 * one, and the server accepts any whole number in range however it was reached.
 */
export function randomStillImageSeedValue() {
  return String(Math.floor(Math.random() * (STILL_IMAGE_MAX_SEED + 1)));
}

/**
 * The seed `delta` away from this one, clamped to the range the server accepts.
 *
 * Stepping walks to an unrelated render, not a nudged one: the graph derives its
 * per-node seeds from the master through a hash (backend/src/stillImageSeed.ts), so
 * 184992 and 184993 have nothing to do with each other. It is a way to walk a set
 * of takes while keeping one number to write down.
 *
 * Empty stays empty. There is nothing to step from, and picking a base here would
 * pin a seed the artist never chose.
 */
export function stepStillImageSeed(value: string, delta: number) {
  const normalized = normalizeStillImageSeedInput(value);
  if (!normalized) return "";
  const stepped = Number(normalized) + delta;
  if (stepped < 0) return "0";
  return String(stepped > STILL_IMAGE_MAX_SEED ? STILL_IMAGE_MAX_SEED : stepped);
}
