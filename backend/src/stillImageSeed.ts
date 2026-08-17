// Seeds for the Still Images presets.
//
// Every preset draws several seeds -- General Enhancement and Reference Generator
// take four each -- and before this they were four independent Math.random()
// calls thrown away after the graph was built. That made a result impossible to
// reproduce: re-running the same inputs rolled a new image, so "keep that
// composition, nudge one slider" was not a thing an artist could ask for.
//
// So the job carries one master seed, and the per-node seeds are derived from it.
// One number to persist, show and resubmit, and the same number reproduces the
// same render provided the settings and inputs match.
//
// Kept as its own module rather than added to stillImageCategories.ts: that file
// mirrors a frontend copy setting-for-setting, and rather than in
// stillImageWorkflow.ts: the submission route mints seeds and must not pull in
// that module's fs/config imports to do it.

/**
 * The largest seed a job may carry.
 *
 * 2^32-1 rather than something longer on purpose: the generator below has 32 bits
 * of state, so a wider visible range would let two different seeds fold onto the
 * same sequence -- a "new seed" that silently repeats the previous render.
 */
export const STILL_IMAGE_MAX_SEED = 4_294_967_295;

export function isStillImageSeed(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= STILL_IMAGE_MAX_SEED;
}

export function randomStillImageSeed() {
  return Math.floor(Math.random() * (STILL_IMAGE_MAX_SEED + 1));
}

/**
 * The per-node seed draws for one master seed, in call order.
 *
 * mulberry32. The graph seeds only have to be stable, distinct and well spread --
 * nothing here is security-sensitive, and ComfyUI treats them as opaque.
 *
 * Call order is what ties a draw to a node, so a preset's apply() must keep
 * drawing in a fixed order for a seed to stay meaningful across releases.
 * Reordering the nextSeed() calls in a preset re-renders old seeds differently;
 * that is a behaviour change to make deliberately, not by accident.
 */
export function stillImageSeedSequence(masterSeed: number) {
  let state = masterSeed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let draw = Math.imul(state ^ (state >>> 15), 1 | state);
    draw = (draw + Math.imul(draw ^ (draw >>> 7), 61 | draw)) ^ draw;
    return (draw ^ (draw >>> 14)) >>> 0;
  };
}
