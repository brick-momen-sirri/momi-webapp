// LTX 2.5 CQ Image to Video, as the form needs it: identity and the pre-flight
// quote. Mirrors backend/src/ltxCqImageToVideo.ts by hand, like the rest of the
// estimator; the backend plans the real job.

import type { ModelType } from "../../types";

/** MUST match LTX_CQ_I2V_MODEL_ID in backend/src/ltxCqImageToVideo.ts. */
export const LTX_CQ_I2V_MODEL_ID = "ltx25_cq_i2v";

const GENERATION_SIZE: Readonly<Record<string, { width: number; height: number }>> = {
  "1080p": { width: 1920, height: 1088 },
  "1440p": { width: 2560, height: 1440 },
};
const USD_PER_SECOND = 0.000462;
const CREDITS_PER_USD = 211;

export function isLtxCqI2vModel(model: Pick<ModelType, "id"> | undefined) {
  return model?.id === LTX_CQ_I2V_MODEL_ID;
}

export function ltxCqI2vCredits(resolution: string, durationSeconds: number) {
  const size = GENERATION_SIZE[resolution.toLowerCase()] ?? GENERATION_SIZE["1440p"];
  const seconds = [2, 3, 4, 5].includes(durationSeconds) ? durationSeconds : 5;
  const billedSeconds = 60 + 0.45 * ((size.width * size.height * (seconds * 24 + 1)) / 1_000_000);
  return Math.max(1, Math.ceil(billedSeconds * USD_PER_SECOND * CREDITS_PER_USD));
}
