// LTX 2.5 CQ First & Last Frame, as the form needs it: identity and the pre-flight
// quote. Mirrors backend/src/ltxCqFirstLastFrame.ts by hand, like the rest of the
// estimator; the backend plans and checks the real job.

import type { ModelType } from "../../types";

/** MUST match LTX_CQ_FLF_MODEL_ID in backend/src/ltxCqFirstLastFrame.ts. */
export const LTX_CQ_FLF_MODEL_ID = "ltx25_cq_flf2v";

/** Worker execution measured per preset at 121 frames; see ltxCqFlfSeconds on the backend. */
const MEASURED_EXECUTION_SECONDS_121: Readonly<Record<string, number>> = {
  "720p": 59,
  "1080p": 118.4,
  "1440p": 280.5,
};
const USD_PER_SECOND = 0.000462;
const CREDITS_PER_USD = 211;

export function isLtxCqFlfModel(model: Pick<ModelType, "id"> | undefined) {
  return model?.id === LTX_CQ_FLF_MODEL_ID;
}

export function ltxCqFlfCredits(resolution: string, durationSeconds: number) {
  const execution = MEASURED_EXECUTION_SECONDS_121[resolution.toLowerCase()] ?? MEASURED_EXECUTION_SECONDS_121["1080p"];
  const seconds = [2, 3, 4, 5].includes(durationSeconds) ? durationSeconds : 5;
  const billedSeconds = 60 + execution * ((seconds * 24 + 1) / 121);
  return Math.max(1, Math.ceil(billedSeconds * USD_PER_SECOND * CREDITS_PER_USD));
}
