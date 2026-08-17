import { useState } from "react";
import type { UploadedImage } from "../../types";
import { normalizeStillImageSeedInput } from "./seed";
import {
  createInitialStillImagesState,
  getStillImageCategory,
  type StillImageCategoryId,
  type StillImageCategoryState,
  type StillImageSettingValue,
} from "./stillImageCategories";

export function useStillImagesForm() {
  const [selectedCategoryId, setSelectedCategoryId] = useState<StillImageCategoryId>("general-enhancement");
  const [stateByCategory, setStateByCategory] = useState(createInitialStillImagesState);
  const [targetFolderId, setTargetFolderId] = useState("");
  const [saveNumber, setSaveNumber] = useState("0000");
  const selectedCategory = getStillImageCategory(selectedCategoryId);
  const selectedState = stateByCategory[selectedCategoryId];

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
    setStateByCategory((current) => ({
      ...current,
      [categoryId]: {
        ...createInitialStillImagesState()[categoryId],
        ...state,
        seed: normalizeStillImageSeedInput(state.seed ?? ""),
      },
    }));
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
  };
}
