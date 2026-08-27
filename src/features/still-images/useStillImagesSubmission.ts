import { useCallback, useEffect, useRef, useState } from "react";

import { createBackendJob, fetchBackendJob, uploadBackendMedia } from "../../services/backendApi";
import { resolveMediaUrl } from "../../services/api/mediaAccess";
import type { Job, StillImageEditWorkflow, UploadedImage } from "../../types";
import { createClientId } from "../../utils/id";
// Shared media helper; features/jobs uses the same one for the Animation path.
import { uploadJobMediaUrl } from "../generation/generationUtils";
import {
  drawingForCrop,
  editCropHeight,
  editCropWidth,
  descriptorMaskDrawing,
  editGenerationBaseLayers,
  type EditLayerCompositeDescriptor,
} from "./imageEditLayers";
import { hasPaintedRegion, type MaskDrawing } from "./maskDrawing";
import {
  canvasToPngFile,
  currentMaskEditCrop,
  loadImageElement,
  maskImageToAlphaCanvas,
  maskHasCoverage,
  renderEditCropCanvas,
  renderGuideCanvas,
  renderMaskCanvas,
} from "./maskRaster";
import { stepStillImageSeed, submittableStillImageSeed } from "./seed";
import {
  getStillImageCategory,
  createInitialStillImagesState,
  shouldShowStillImagePrompt,
  stillImageSlotCount,
  visibleStillImageSettings,
  type StillImageSettingValue,
  type StillImageCategoryId,
  type StillImageCategoryState,
} from "./stillImageCategories";
import { stillImageModelId } from "./stillImageModelId";

export type StillImagesSubmissionState = {
  submitting: boolean;
  phase?: "preparing" | "processing";
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
export function useStillImagesSubmission(options: {
  onJobCreated: (job: Job) => void;
  onJobUpdated?: (job: Job) => void;
  onEditJobCompleted?: (job: Job) => void;
  onError?: (message: string) => void;
}) {
  const [state, setState] = useState<StillImagesSubmissionState>({ submitting: false });
  // Survives a failed attempt so a retry is recognised as the same submission.
  const pendingRequestIdRef = useRef<string[] | undefined>(undefined);
  const inFlightRef = useRef(false);
  const lifecycleAbortRef = useRef<AbortController | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lifecycleAbortRef.current?.abort();
    };
  }, []);

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
      const paintsItsOwnSlots = input.categoryId === "image-editing";
      // Only the uploaded slots. Image Editing draws the rest from the painted
      // region, so its images array is short by design and must not be measured
      // against the slot count the request will end up carrying.
      const uploadedSlotCount = paintsItsOwnSlots ? 1 : slotCount;
      const images = input.categoryState.images.slice(0, uploadedSlotCount).filter(Boolean);

      if (!input.projectId) return fail("Select a project before generating.");
      if (images.length !== uploadedSlotCount) {
        return fail(`This workflow needs ${uploadedSlotCount} input image${uploadedSlotCount === 1 ? "" : "s"}.`);
      }
      if (paintsItsOwnSlots && !hasPaintedRegion(input.categoryState.mask)) {
        return fail("Paint or select the region to edit before generating.");
      }
      // React cannot paint the disabled button until this event returns. A ref is
      // the synchronous guard that closes the tiny gap in which a fast double-click
      // could otherwise submit the same edit twice.
      if (inFlightRef.current) {
        return { ok: false as const, error: "This edit is already processing." };
      }
      const editMode = input.categoryState.editMode ?? "inpaint";
      // General Enhancement has no reference-conditioning branch. Keep the
      // selection in editor state when modes are switched, but only send it to
      // the Nano Banana Inpaint graph that can actually consume it.
      const references = editMode === "inpaint" ? (input.categoryState.editReferences ?? []) : [];
      const backendCategoryId: StillImageCategoryId =
        paintsItsOwnSlots && editMode === "enhance" ? "general-enhancement" : input.categoryId;
      const backendCategory = getStillImageCategory(backendCategoryId);

      inFlightRef.current = true;
      setState({ submitting: true, phase: "preparing" });
      // Regeneration replaces one layer. Extra variations would silently create
      // sibling layers, contradicting the explicit regenerate action.
      const variations = stillImageSubmissionCount(input.categoryId, input.categoryState);
      const clientRequestIds = takeRequestIds(pendingRequestIdRef, variations);

      try {
        // Blob and data URLs have to become saved project media first: the backend
        // materializer only accepts saved media or data URLs, and for the base64
        // presets it needs bytes it can read locally rather than a remote link.
        const uploaded = await Promise.all(
          images.map((image, index) =>
            index === 0 && paintsItsOwnSlots && input.categoryState.editOriginalSourceUrl
              ? Promise.resolve(input.categoryState.editOriginalSourceUrl)
              : uploadJobMediaUrl(imageSourceUrl(image), { projectId: input.projectId, kind: "image", name: image.name }),
          ),
        );
        const referenceSourceUrls = paintsItsOwnSlots
          ? await Promise.all(
              references
                .slice(0, 3)
                .map((image) =>
                  uploadJobMediaUrl(imageSourceUrl(image), { projectId: input.projectId, kind: "image", name: image.name }),
                ),
            )
          : [];
        // Rendered and uploaded once, then shared by every variation: they differ
        // only by seed, and re-rendering a 4K mask per job would pay for the same
        // bytes three times over.
        const painted = paintsItsOwnSlots
          ? await uploadPaintedSlots({
              projectId: input.projectId,
              sourceUrl: imageSourceUrl(images[0]),
              originalSourceUrl: uploaded[0],
              drawing: input.categoryState.mask as MaskDrawing,
              mode: editMode,
              documentId: input.categoryState.editDocumentId ?? createClientId("editdoc_"),
              includeGuide: editMode === "inpaint",
              referenceSourceUrls,
              layers: editGenerationBaseLayers(input.categoryState),
            })
          : undefined;
        // Image Editing sends the cropped source/mask/guide only. The durable
        // original URL lives in edit metadata for the backend composite step, but
        // is deliberately absent from the RunPod payload.
        const inputImages = painted?.inputImages ?? uploaded;

        // Only the settings the artist can currently see. The server drops hidden
        // ones anyway; sending them would just be noise.
        // An enhance run is a general-enhancement job, so it is described by that
        // preset's settings rather than Image Editing's. What the artist set in
        // the editor is layered over that preset's defaults; anything they never
        // touched stays at the default the preset declares.
        const effectiveState =
          backendCategoryId === input.categoryId
            ? input.categoryState
            : withEnhanceOverrides(createInitialStillImagesState()[backendCategoryId], input.categoryState.editEnhanceSettings);
        const settings = Object.fromEntries(
          visibleStillImageSettings(backendCategory, effectiveState).map((setting) => [
            setting.id,
            effectiveState.settings[setting.id],
          ]),
        );
        if (backendCategoryId === "image-editing") settings.markRegion = true;
        // Omitted unless the artist asked for a particular seed, which is normally
        // one restored from an earlier result. The server mints one either way and
        // records it on the job, so the render stays reproducible without anyone
        // having to think about it.
        const pinnedSeed = submittableStillImageSeed(input.categoryState.seed);

        let creation: Awaited<ReturnType<typeof createBackendJob>> | undefined;
        const createdJobs: Job[] = [];
        const requestedEdits = new Map<string, StillImageEditWorkflow>();
        for (const [index, clientRequestId] of clientRequestIds.entries()) {
          const requestedEdit: StillImageEditWorkflow | undefined = painted
            ? {
                ...painted.edit,
                layerId:
                  index === 0 && input.categoryState.activeEditLayerId
                    ? input.categoryState.activeEditLayerId
                    : `edit_${clientRequestId}`,
                operation: index === 0 && input.categoryState.activeEditLayerId ? "regenerate" : "create",
              }
            : undefined;
          creation = await createBackendJob({
            clientRequestId,
            projectId: input.projectId,
            targetFolderId: input.targetFolderId || null,
            modelId: stillImageModelId(backendCategoryId),
            // Omitted entirely when the preset hides the prompt field: the server
            // rejects a prompt on a promptless preset rather than ignoring it.
            prompt: shouldShowStillImagePrompt(backendCategory, effectiveState) ? input.categoryState.prompt.trim() : undefined,
            inputImages,
            workflowOptions: {
              stillImage: {
                categoryId: backendCategoryId,
                // A pinned seed has to be walked, or every variation of a pinned
                // render would come back the same image. Unpinned, the server
                // draws one per job and they differ on their own.
                seed: pinnedSeed === undefined ? undefined : steppedSeed(pinnedSeed, index),
                settings,
                edit: requestedEdit,
              },
              save: { cameraNumber: input.saveNumber },
            },
          });
          createdJobs.push(creation.job);
          if (requestedEdit) requestedEdits.set(creation.job.id, requestedEdit);
          options.onJobCreated(creation.job);
        }
        if (!creation) return fail("Nothing was submitted.");

        pendingRequestIdRef.current = undefined;
        if (paintsItsOwnSlots) {
          setState({ submitting: true, phase: "processing" });
          const controller = new AbortController();
          lifecycleAbortRef.current = controller;
          const finishedJobs = await waitForTerminalJobs(createdJobs, {
            signal: controller.signal,
            onUpdate: options.onJobUpdated,
          });
          lifecycleAbortRef.current = undefined;

          const completed = finishedJobs.filter((job) => job.status === "completed");
          const failed = finishedJobs.filter((job) => job.status === "failed" || job.status === "canceled");
          for (const job of completed) {
            const readyJob = completedEditJob(job, requestedEdits.get(job.id));
            // Publish the repaired terminal record before the layer callback. A
            // rolling deploy can briefly pair the new editor with an old API
            // process that accepted the crop but stripped its edit metadata. In
            // that case the provider result is still the generated crop and the
            // request snapshot is enough to apply it safely instead of silently
            // finishing with no layer.
            options.onJobUpdated?.(readyJob);
            options.onEditJobCompleted?.(readyJob);
          }
          if (failed.length) {
            const detail = failed.map((job) => job.errorMessage).find(Boolean);
            throw new Error(
              detail ?? (failed.some((job) => job.status === "canceled") ? "The edit was canceled." : "The edit failed."),
            );
          }
        }
        if (mountedRef.current) setState({ submitting: false });
        // The last job, for a caller that wants one back. Every job was handed to
        // onJobCreated as it landed, which is what the feed actually reads.
        return { ok: true as const, job: creation.job, jobs: createdJobs, replayed: creation.replayed };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return { ok: false as const, error: "The edit status check was canceled." };
        }
        const message = error instanceof Error ? error.message : "Could not start this still image job.";
        if (mountedRef.current) setState({ submitting: false, error: message });
        options.onError?.(message);
        return { ok: false as const, error: message };
      } finally {
        inFlightRef.current = false;
      }

      function fail(message: string) {
        if (mountedRef.current) setState({ submitting: false, error: message });
        options.onError?.(message);
        return { ok: false as const, error: message };
      }
    },
    [options],
  );

  return { ...state, submit };
}

const EDIT_JOB_POLL_INTERVAL_MS = 1_500;
const TERMINAL_JOB_STATUSES = new Set<Job["status"]>(["completed", "failed", "canceled"]);

/**
 * Require a completed edit to be usable by the canvas, not merely terminal.
 *
 * The normal path is backend-authored `generatedCropUrl`: the backend preserved
 * the provider crop and also wrote the full composite to the ordinary result.
 * The fallback covers a rolling-version mismatch observed in production, where
 * an older API stripped the newly introduced edit envelope. That older backend
 * left the provider crop as result zero, so pairing it with the exact request
 * snapshot reconstructs the layer without guessing coordinates or mask data.
 */
export function completedEditJob(job: Job, requestedEdit: StillImageEditWorkflow | undefined): Job {
  const returnedEdit = job.workflowOptions?.stillImage?.edit;
  if (returnedEdit?.generatedCropUrl) return job;

  if (returnedEdit) {
    throw new Error(
      "The edit finished, but the backend did not return its generated crop. The mask and prompt were kept; retry the edit.",
    );
  }

  const generatedCropUrl = job.resultSourceUrls?.[0];
  if (!requestedEdit || !generatedCropUrl || !job.resultUrl) {
    throw new Error(
      "The edit finished without a usable image or layer description. The mask and prompt were kept; retry the edit.",
    );
  }

  return {
    ...job,
    workflowOptions: {
      ...job.workflowOptions,
      stillImage: {
        categoryId: requestedEdit.mode === "enhance" ? "general-enhancement" : "image-editing",
        seed: job.workflowOptions?.stillImage?.seed,
        settings: job.workflowOptions?.stillImage?.settings ?? {},
        edit: { ...requestedEdit, generatedCropUrl },
      },
    },
  };
}

/**
 * Follow the exact jobs returned by POST /api/jobs until Comfy has produced an
 * output or a terminal error. The workspace's broad 12-second refresh remains a
 * fallback, while this targeted poll makes the canvas lifecycle immediate and
 * prevents an unrelated page/filter change from losing the editor's completion.
 */
async function waitForTerminalJobs(initialJobs: Job[], options: { signal: AbortSignal; onUpdate?: (job: Job) => void }) {
  const jobs = new Map(initialJobs.map((job) => [job.id, job]));
  while (true) {
    const pendingIds = [...jobs.values()].filter((job) => !TERMINAL_JOB_STATUSES.has(job.status)).map((job) => job.id);
    if (!pendingIds.length) return [...jobs.values()];

    const updates = await Promise.all(pendingIds.map((jobId) => fetchBackendJob(jobId, { signal: options.signal })));
    for (const job of updates) {
      jobs.set(job.id, job);
      options.onUpdate?.(job);
    }
    if ([...jobs.values()].every((job) => TERMINAL_JOB_STATUSES.has(job.status))) return [...jobs.values()];
    await abortableDelay(EDIT_JOB_POLL_INTERVAL_MS, options.signal);
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * Idempotency keys for this attempt, minted once and reused if it is retried.
 *
 * One per variation, because they are separate jobs: sharing a key would have the
 * server replay the first job for the rest, and the artist would get one image
 * back where they asked for three. Held across a failure for the same reason a
 * single submission holds one -- a network error after the server accepted job two
 * must not pay for job two twice.
 */
function takeRequestIds(store: { current: string[] | undefined }, count: number) {
  const existing = store.current;
  if (existing?.length === count) return existing;
  const ids = Array.from({ length: count }, () => createClientId("still_").padEnd(16, "0").slice(0, 40));
  store.current = ids;
  return ids;
}

/**
 * How many variations to run.
 *
 * Clamped rather than trusted: the value comes from a slider whose bounds the
 * shared preset table owns, and a setting stored by an older build could sit
 * outside them. Anything unreadable is one run, never none.
 */
function variationCount(value: unknown) {
  const count = Math.round(Number(value));
  return Number.isFinite(count) ? Math.min(4, Math.max(1, count)) : 1;
}

export function stillImageSubmissionCount(categoryId: StillImageCategoryId, state: StillImageCategoryState) {
  if (categoryId !== "image-editing" || state.activeEditLayerId) return 1;
  return variationCount(state.settings.variations);
}

/** The nth neighbouring seed, through the same stepper the seed buttons use. */
function steppedSeed(seed: number, offset: number) {
  return Number(stepStillImageSeed(String(seed), offset));
}

/**
 * Render the painted or rectangle-selected region into the graph's image slots.
 *
 * Slot 2 is the mask, slot 3 the source with the region washed over. Both are
 * drawn at the source's own resolution -- the graph pastes the result back through
 * the mask pixel for pixel, so a mask at any other size would land the edit
 * somewhere other than where it was painted.
 */
async function uploadPaintedSlots(options: {
  projectId: string;
  sourceUrl: string;
  originalSourceUrl: string;
  drawing: MaskDrawing;
  mode: "inpaint" | "enhance";
  documentId: string;
  includeGuide: boolean;
  referenceSourceUrls: string[];
  layers: EditLayerCompositeDescriptor[];
}) {
  // Same as the editor: saved project media needs the media credential to decode,
  // and a blob: URL from an upload resolves to itself.
  const source = await loadImageElement(resolveMediaUrl(options.sourceUrl));
  const drawing: MaskDrawing = {
    ...options.drawing,
    width: source.naturalWidth || source.width,
    height: source.naturalHeight || source.height,
  };

  // The panel checks that strokes exist; this checks that they still cover
  // something. Painting an area and then erasing all of it leaves strokes and no
  // coverage, and that mask would let the model repaint the whole frame.
  if (!maskHasCoverage(drawing)) {
    throw new Error("The edit region is empty. Paint or select the area to change, then try again.");
  }

  const crop = currentMaskEditCrop(drawing);
  if (!crop) {
    throw new Error("The edit region is empty. Paint or select the area to change, then try again.");
  }
  const layerSources = await Promise.all(
    options.layers.map(async (layer) => {
      const image = await loadImageElement(layer.generatedCropUrl ?? resolveMediaUrl(layer.generatedCropSourceUrl));
      // The model has to be shown the composite the artist is looking at, so a
      // faded, moved or unmasked layer goes into the crop faded, moved and
      // unmasked rather than at the values it was generated with.
      const placement = {
        crop: layer.crop,
        opacity: layer.opacity,
        offset: layer.offset,
        maskOffset: layer.maskOffset,
        maskEnabled: layer.maskEnabled,
        maskFeather: layer.maskFeather,
      };
      if (layer.mask) return { image, ...placement, drawing: layer.mask };
      if (layer.maskSourceUrl) {
        const mask = await loadImageElement(resolveMediaUrl(layer.maskSourceUrl));
        return {
          image,
          ...placement,
          mask: maskImageToAlphaCanvas(mask, editCropWidth(layer.crop), editCropHeight(layer.crop)),
        };
      }
      throw new Error(`The saved base for ${layer.layerId} is missing its mask.`);
    }),
  );
  const cropDrawing = drawingForCrop(drawing, crop);
  const sourceCrop = renderEditCropCanvas(source, crop, layerSources);
  const files = [
    await canvasToPngFile(sourceCrop, "edit-source-crop.png"),
    await canvasToPngFile(renderMaskCanvas(cropDrawing), "edit-mask-crop.png"),
  ];
  if (options.includeGuide) files.push(await canvasToPngFile(renderGuideCanvas(sourceCrop, cropDrawing), "edit-guide-crop.png"));

  const inputImages = await Promise.all(
    files.map((file) => uploadBackendMedia(file, { projectId: options.projectId, kind: "image", name: file.name })),
  );
  inputImages.push(...options.referenceSourceUrls);
  // A layer mask may have been edited since that layer was generated. Re-render
  // the small crop masks so the backend's full composite uses the current masks,
  // without ever re-uploading the original or a full-resolution mask.
  const baseLayers = await Promise.all(
    options.layers.map(async (layer) => {
      let maskSourceUrl = layer.maskSourceUrl;
      const resolvedMask = descriptorMaskDrawing(layer);
      if (resolvedMask) {
        const file = await canvasToPngFile(
          renderMaskCanvas(drawingForCrop(resolvedMask, layer.crop)),
          `${layer.layerId}-mask.png`,
        );
        maskSourceUrl = await uploadBackendMedia(file, {
          projectId: options.projectId,
          kind: "image",
          name: file.name,
        });
      }
      if (!maskSourceUrl) throw new Error(`The saved base for ${layer.layerId} is missing its mask.`);
      return {
        layerId: layer.layerId,
        crop: layer.crop,
        generatedCropUrl: layer.generatedCropSourceUrl,
        maskSourceUrl,
        opacity: layer.opacity,
        maskFeather: layer.maskFeather,
        offset: layer.offset,
      };
    }),
  );
  return {
    inputImages,
    edit: {
      // Filled per variation in the submission loop.
      layerId: "",
      operation: "create" as const,
      mode: options.mode,
      documentId: options.documentId,
      crop,
      mask: drawing,
      originalSourceUrl: options.originalSourceUrl,
      maskSourceUrl: inputImages[1],
      baseLayerIds: baseLayers.map((layer) => layer.layerId),
      baseLayers,
      referenceSourceUrls: options.referenceSourceUrls,
    },
  };
}

/** The borrowed preset's state, with the editor's own choices written over it. */
function withEnhanceOverrides(state: StillImageCategoryState, overrides: Record<string, StillImageSettingValue> | undefined) {
  if (!overrides) return state;
  return { ...state, settings: { ...state.settings, ...overrides } };
}

function imageSourceUrl(image: UploadedImage) {
  // Use the upload's prepared source when one exists. The mask editor's own crop
  // aspect is independent and is calculated later around current mask coverage.
  return image.croppedUrl ?? image.url;
}
