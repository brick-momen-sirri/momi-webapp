import type { StillImageCategoryId } from "./stillImageCategories";

/**
 * The backend model id for a Still Images preset.
 *
 * MUST stay in step with stillImageModelId in backend/src/stillImageModels.ts. The
 * submission carries both this and workflowOptions.stillImage.categoryId, and the
 * server rejects a request where they disagree -- the endpoint is chosen from the
 * category while the graph comes from the model, so a mismatch would run one
 * preset's graph on another preset's pod.
 *
 * A drift here is therefore a 400 with a clear message rather than a wrong render,
 * and stillImageModelId.test.ts asserts the format on this side.
 */
export function stillImageModelId(categoryId: StillImageCategoryId) {
  return `still_${categoryId}`;
}
