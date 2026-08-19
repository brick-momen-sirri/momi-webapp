import { useEffect, useState } from "react";
import type { UploadedImage } from "../../types";
import { revokeImageObjectUrls } from "../../utils/uploadedImage";
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
    updateSelectedState({ images });
  }

  function setPrompt(prompt: string) {
    updateSelectedState({ prompt });
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
      images[0] = image;
      return { ...current, [categoryId]: { ...current[categoryId], images } };
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
    setPrompt,
    setSeed,
    setSetting,
    setTargetFolderId,
    setSaveNumber,
    loadCategoryState,
    useResultAsInput,
  };
}
