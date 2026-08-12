import { useCallback, useRef, useState } from "react";

import { createBackendJob } from "../../services/backendApi";
import type { Job, UploadedImage } from "../../types";
import { createClientId } from "../../utils/id";
// Shared media helper; features/jobs uses the same one for the Animation path.
import { uploadJobMediaUrl } from "../generation/generationUtils";
import {
  getStillImageCategory,
  shouldShowStillImagePrompt,
  stillImageSlotCount,
  visibleStillImageSettings,
  type StillImageCategoryId,
  type StillImageCategoryState,
} from "./stillImageCategories";
import { stillImageModelId } from "./stillImageModelId";

export type StillImagesSubmissionState = {
  submitting: boolean;
  error?: string;
};

/**
 * Submit a Still Images preset as a backend job.
 *
 * Kept separate from useJobSubmission rather than folded into it. That hook is
 * built around the Animation form -- model selection, resolution, duration, video,
 * ArchViz grid -- and none of it applies here. What is worth copying is its
 * idempotency: a clientRequestId is minted once per attempt and reused if the same
 * attempt is retried, so a network failure after the server accepted the job
 * replays the existing one instead of paying for a second render.
 */
export function useStillImagesSubmission(options: { onJobCreated: (job: Job) => void; onError?: (message: string) => void }) {
  const [state, setState] = useState<StillImagesSubmissionState>({ submitting: false });
  // Survives a failed attempt so a retry is recognised as the same submission.
  const pendingRequestIdRef = useRef<string | undefined>(undefined);

  const submit = useCallback(
    async (input: {
      projectId: string;
      categoryId: StillImageCategoryId;
      categoryState: StillImageCategoryState;
      targetFolderId: string;
      saveNumber: string;
    }) => {
      const category = getStillImageCategory(input.categoryId);
      const slotCount = stillImageSlotCount(category, input.categoryState);
      const images = input.categoryState.images.slice(0, slotCount).filter(Boolean);

      if (!input.projectId) return fail("Select a project before generating.");
      if (images.length !== slotCount) {
        return fail(`This workflow needs ${slotCount} input image${slotCount === 1 ? "" : "s"}.`);
      }

      setState({ submitting: true });
      const clientRequestId = pendingRequestIdRef.current ?? createClientId("still_").padEnd(16, "0").slice(0, 40);
      pendingRequestIdRef.current = clientRequestId;

      try {
        // Blob and data URLs have to become saved project media first: the backend
        // materializer only accepts saved media or data URLs, and for the base64
        // presets it needs bytes it can read locally rather than a remote link.
        const inputImages = await Promise.all(
          images.map((image) =>
            uploadJobMediaUrl(imageSourceUrl(image), { projectId: input.projectId, kind: "image", name: image.name }),
          ),
        );

        const creation = await createBackendJob({
          clientRequestId,
          projectId: input.projectId,
          targetFolderId: input.targetFolderId || null,
          modelId: stillImageModelId(input.categoryId),
          // Omitted entirely when the preset hides the prompt field: the server
          // rejects a prompt on a promptless preset rather than ignoring it.
          prompt: shouldShowStillImagePrompt(category, input.categoryState) ? input.categoryState.prompt.trim() : undefined,
          inputImages,
          workflowOptions: {
            stillImage: {
              categoryId: input.categoryId,
              // Only the settings the artist can currently see. The server drops
              // hidden ones anyway; sending them would just be noise.
              settings: Object.fromEntries(
                visibleStillImageSettings(category, input.categoryState).map((setting) => [
                  setting.id,
                  input.categoryState.settings[setting.id],
                ]),
              ),
            },
            save: { cameraNumber: input.saveNumber },
          },
        });

        pendingRequestIdRef.current = undefined;
        setState({ submitting: false });
        options.onJobCreated(creation.job);
        return { ok: true as const, job: creation.job, replayed: creation.replayed };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not start this still image job.";
        setState({ submitting: false, error: message });
        options.onError?.(message);
        return { ok: false as const, error: message };
      }

      function fail(message: string) {
        setState({ submitting: false, error: message });
        options.onError?.(message);
        return { ok: false as const, error: message };
      }
    },
    [options],
  );

  return { ...state, submit };
}

function imageSourceUrl(image: UploadedImage) {
  // No 16:9 crop surface in Still Images, so the cropped variant is only used when
  // the uploader produced one anyway.
  return image.croppedUrl ?? image.url;
}
