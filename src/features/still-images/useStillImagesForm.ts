import { useEffect, useState } from "react";
import { resolveMediaUrl } from "../../services/api/mediaAccess";
import type { Job, UploadedImage } from "../../types";
import { createClientId } from "../../utils/id";
import { revokeImageObjectUrls } from "../../utils/uploadedImage";
import { baseRevisionId } from "./imageEditLayers";
import type { MaskDrawing } from "./maskDrawing";
import { normalizeStillImageSeedInput } from "./seed";
import { readPersistedStillImagesForm, writePersistedStillImagesForm } from "./stillImagePreferences";
import {
  createInitialStillImagesState,
  getStillImageCategory,
  type StillImageCategoryId,
  type StillImageCategoryState,
  type StillImageSettingValue,
} from "./stillImageCategories";

export function useStillImagesForm() {
  // Read once, lazily, the same way the Animation form takes its persisted settings.
  // Everything but the images comes back; stillImagePreferences.ts explains why they
  // do not.
  const [restored] = useState(readPersistedStillImagesForm);
  const [selectedCategoryId, setSelectedCategoryId] = useState<StillImageCategoryId>(restored.selectedCategoryId);
  const [stateByCategory, setStateByCategory] = useState(restored.stateByCategory);
  const [targetFolderId, setTargetFolderId] = useState(restored.targetFolderId);
  const [saveNumber, setSaveNumber] = useState(restored.saveNumber);
  const selectedCategory = getStillImageCategory(selectedCategoryId);
  const selectedState = stateByCategory[selectedCategoryId];

  // Every preset's fields, not just the visible one's: switching category and back is
  // one of the ways this state was being lost.
  useEffect(() => {
    writePersistedStillImagesForm({ selectedCategoryId, stateByCategory, targetFolderId, saveNumber });
  }, [saveNumber, selectedCategoryId, stateByCategory, targetFolderId]);

  function updateSelectedState(update: Partial<(typeof stateByCategory)[StillImageCategoryId]>) {
    setStateByCategory((current) => ({
      ...current,
      [selectedCategoryId]: { ...current[selectedCategoryId], ...update },
    }));
  }

  function setImages(images: UploadedImage[]) {
    const nextDocumentId = selectedCategoryId === "image-editing" && images[0] ? createClientId("editdoc_") : undefined;
    setStateByCategory((current) => {
      const state = current[selectedCategoryId];
      const sourceChanged = state.images[0]?.id !== images[0]?.id;
      if (selectedCategoryId === "image-editing" && sourceChanged) {
        state.editReferences?.forEach(revokeImageObjectUrls);
      }
      return {
        ...current,
        [selectedCategoryId]: {
          ...state,
          images,
          ...(selectedCategoryId === "image-editing" && sourceChanged
            ? {
                mask: undefined,
                editLayers: [],
                activeEditLayerId: undefined,
                editDocumentId: nextDocumentId,
                editMode: "inpaint" as const,
                editReferences: [],
                editOriginalSourceUrl: undefined,
              }
            : {}),
        },
      };
    });
  }

  /**
   * The painted region for the preset that has one.
   *
   * Cleared rather than rescaled when the source changes -- MaskRegionField owns
   * that check, because it is the only part of the app holding the decoded image
   * the strokes were painted against.
   */
  function setMask(mask: MaskDrawing | undefined) {
    setStateByCategory((current) => {
      const state = current[selectedCategoryId];
      const editLayers = state.activeEditLayerId
        ? (state.editLayers ?? []).map((layer) =>
            layer.id === state.activeEditLayerId
              ? {
                  ...layer,
                  mask: mask ?? { ...layer.mask, strokes: [] },
                  revision: (layer.revision ?? 0) + 1,
                  updatedAt: new Date().toISOString(),
                }
              : layer,
          )
        : state.editLayers;
      return { ...current, [selectedCategoryId]: { ...state, mask, editLayers } };
    });
  }

  function setPrompt(prompt: string) {
    setStateByCategory((current) => {
      const state = current[selectedCategoryId];
      const editLayers = state.activeEditLayerId
        ? (state.editLayers ?? []).map((layer) =>
            layer.id === state.activeEditLayerId ? { ...layer, prompt, updatedAt: new Date().toISOString() } : layer,
          )
        : state.editLayers;
      return { ...current, [selectedCategoryId]: { ...state, prompt, editLayers } };
    });
  }

  function setSeed(seed: string) {
    updateSelectedState({ seed: normalizeStillImageSeedInput(seed) });
  }

  function setSetting(settingId: string, value: StillImageSettingValue) {
    setStateByCategory((current) => ({
      ...current,
      [selectedCategoryId]: {
        ...current[selectedCategoryId],
        settings: { ...current[selectedCategoryId].settings, [settingId]: value },
      },
    }));
  }

  function setEditMode(editMode: "inpaint" | "enhance") {
    updateSelectedState({ editMode });
  }

  function setEditReferences(editReferences: UploadedImage[]) {
    updateSelectedState({ editReferences });
  }

  /**
   * Select a preset and drop an image into its first slot.
   *
   * What chaining a result into the next preset needs. Unlike loadCategoryState
   * this preserves everything else that preset is holding -- its settings, its
   * prompt, its other slots -- because the artist is carrying one image across,
   * not restoring a saved job.
   *
   * Slot 1 always: it is the main image for every preset, and the later slots
   * are references rather than the thing being worked on.
   */
  function useResultAsInput(categoryId: StillImageCategoryId, image: UploadedImage) {
    setSelectedCategoryId(categoryId);
    setStateByCategory((current) => {
      const images = [...current[categoryId].images];
      // Whatever it displaces may be a locally chosen file, whose bytes stay in
      // the tab until its object URL is released.
      revokeImageObjectUrls(images[0]);
      if (categoryId === "image-editing") current[categoryId].editReferences?.forEach(revokeImageObjectUrls);
      images[0] = image;
      // The strokes were painted on whatever slot 1 used to hold, so they mean
      // nothing against the image being carried in.
      return {
        ...current,
        [categoryId]: {
          ...current[categoryId],
          images,
          mask: undefined,
          ...(categoryId === "image-editing"
            ? {
                editLayers: [],
                activeEditLayerId: undefined,
                editDocumentId: createClientId("editdoc_"),
                editMode: "inpaint" as const,
                editReferences: [],
                editOriginalSourceUrl: undefined,
              }
            : {}),
        },
      };
    });
  }

  function startNewEditLayer() {
    setStateByCategory((current) => {
      current["image-editing"].editReferences?.forEach(revokeImageObjectUrls);
      return {
        ...current,
        "image-editing": {
          ...current["image-editing"],
          activeEditLayerId: undefined,
          mask: undefined,
          prompt: "",
          editReferences: [],
        },
      };
    });
  }

  function selectEditLayer(layerId: string) {
    setStateByCategory((current) => {
      const state = current["image-editing"];
      const layer = (state.editLayers ?? []).find((entry) => entry.id === layerId);
      if (!layer) return current;
      state.editReferences?.forEach(revokeImageObjectUrls);
      return {
        ...current,
        "image-editing": {
          ...state,
          activeEditLayerId: layer.id,
          mask: layer.mask,
          prompt: layer.prompt,
          editMode: layer.mode,
          editReferences: layer.references.map((reference) => ({
            id: reference.id,
            name: reference.name,
            url: reference.sourceUrl,
            previewUrl: reference.previewUrl ?? resolveMediaUrl(reference.sourceUrl),
          })),
        },
      };
    });
  }

  function toggleEditLayer(layerId: string) {
    setStateByCategory((current) => {
      const state = current["image-editing"];
      return {
        ...current,
        "image-editing": {
          ...state,
          editLayers: (state.editLayers ?? []).map((layer) =>
            layer.id === layerId ? { ...layer, visible: !layer.visible, updatedAt: new Date().toISOString() } : layer,
          ),
        },
      };
    });
  }

  function deleteEditLayer(layerId: string) {
    setStateByCategory((current) => {
      const state = current["image-editing"];
      const deletingActive = state.activeEditLayerId === layerId;
      if (deletingActive) state.editReferences?.forEach(revokeImageObjectUrls);
      return {
        ...current,
        "image-editing": {
          ...state,
          editLayers: (state.editLayers ?? []).filter((layer) => layer.id !== layerId),
          ...(deletingActive ? { activeEditLayerId: undefined, mask: undefined, prompt: "", editReferences: [] } : {}),
        },
      };
    });
  }

  function moveEditLayer(layerId: string, direction: -1 | 1) {
    setStateByCategory((current) => {
      const state = current["image-editing"];
      const layers = [...(state.editLayers ?? [])].sort((a, b) => a.order - b.order);
      const from = layers.findIndex((layer) => layer.id === layerId);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= layers.length) return current;
      [layers[from], layers[to]] = [layers[to], layers[from]];
      return {
        ...current,
        "image-editing": { ...state, editLayers: layers.map((layer, order) => ({ ...layer, order })) },
      };
    });
  }

  /** Record a queued edit immediately; result URLs are hydrated from the job list later. */
  function commitEditLayer(job: Job) {
    const edit = job.workflowOptions?.stillImage?.edit;
    if (!edit) return;
    setStateByCategory((current) => {
      const state = current["image-editing"];
      const layers = state.editLayers ?? [];
      const existing = layers.find((layer) => layer.id === edit.layerId);
      const order = existing?.order ?? layers.length;
      const updatedAt = job.completedAt ?? job.startedAt ?? job.createdAt;
      const next = {
        id: edit.layerId,
        name: existing?.name ?? `Edit Layer ${String(order + 1).padStart(2, "0")}`,
        mask: edit.mask as MaskDrawing,
        crop: edit.crop,
        prompt: job.prompt,
        mode: edit.mode,
        documentId: edit.documentId,
        originalSourceUrl: edit.originalSourceUrl,
        references: edit.referenceSourceUrls.map((sourceUrl, index) => ({
          id: `${edit.layerId}_ref_${index + 1}`,
          name: `Reference ${index + 1}`,
          sourceUrl,
        })),
        jobId: job.id,
        createdAt: existing?.createdAt ?? job.createdAt,
        updatedAt,
        visible: existing?.visible ?? true,
        order,
        revision: (existing?.revision ?? 0) + 1,
        status: job.status,
        errorMessage: job.errorMessage,
        // Regeneration is non-destructive while it runs. A queued job has no new
        // crop yet, so retain the last completed take until hydration supplies the
        // replacement asset.
        resultUrl: job.resultUrl ?? existing?.resultUrl,
        generatedCropSourceUrl: edit.generatedCropUrl ?? existing?.generatedCropSourceUrl,
        generatedCropUrl: edit.generatedCropUrl ?? existing?.generatedCropUrl,
        maskSourceUrl: edit.maskSourceUrl ?? existing?.maskSourceUrl,
        baseLayers: edit.baseLayers,
        baseRevisionId: baseRevisionId(edit.baseLayers),
        generation: {
          jobId: job.id,
          workflow: (job.workflowOptions?.stillImage?.categoryId === "general-enhancement"
            ? "general-enhancement"
            : "image-editing") as "general-enhancement" | "image-editing",
          workflowPath: job.workflowPath,
          modelId: job.modelId,
          seed: job.workflowOptions?.stillImage?.seed,
          settings: job.workflowOptions?.stillImage?.settings ?? {},
        },
      };
      state.editReferences?.forEach(revokeImageObjectUrls);
      return {
        ...current,
        "image-editing": {
          ...state,
          editLayers: existing ? layers.map((layer) => (layer.id === edit.layerId ? next : layer)) : [...layers, next],
          activeEditLayerId: edit.layerId,
          mask: next.mask,
          editDocumentId: edit.documentId,
          editMode: edit.mode,
          editOriginalSourceUrl: edit.originalSourceUrl,
          editReferences: next.references.map((reference) => ({
            id: reference.id,
            name: reference.name,
            url: reference.sourceUrl,
            previewUrl: resolveMediaUrl(reference.sourceUrl),
          })),
        },
      };
    });
  }

  /**
   * Select a preset and replace what the form holds for it, in one update.
   *
   * What "Reuse settings" needs: switching category first and then writing the
   * fields would leave the panel showing the new preset's defaults for a render,
   * and setSetting one id at a time cannot clear a setting the saved job did not
   * carry. The state is replaced rather than merged so nothing from the previous
   * occupant of that preset survives into a restored one.
   */
  function loadCategoryState(categoryId: StillImageCategoryId, state: Partial<StillImageCategoryState>) {
    setSelectedCategoryId(categoryId);
    setStateByCategory((current) => {
      // The restored images replace whatever the preset was holding, and a
      // locally chosen file keeps its bytes in the tab until it is released.
      current[categoryId].images.forEach(revokeImageObjectUrls);
      return {
        ...current,
        [categoryId]: {
          ...createInitialStillImagesState()[categoryId],
          ...state,
          seed: normalizeStillImageSeedInput(state.seed ?? ""),
        },
      };
    });
  }

  return {
    selectedCategoryId,
    selectedCategory,
    selectedState,
    targetFolderId,
    saveNumber,
    setSelectedCategoryId,
    setImages,
    setMask,
    setPrompt,
    setSeed,
    setSetting,
    setEditMode,
    setEditReferences,
    setTargetFolderId,
    setSaveNumber,
    loadCategoryState,
    useResultAsInput,
    startNewEditLayer,
    selectEditLayer,
    toggleEditLayer,
    deleteEditLayer,
    moveEditLayer,
    commitEditLayer,
  };
}
