import { useState } from "react";
import type { UploadedImage } from "../../types";
import {
  createInitialStillImagesState,
  getStillImageCategory,
  type StillImageCategoryId,
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

  function setSetting(settingId: string, value: StillImageSettingValue) {
    setStateByCategory((current) => ({
      ...current,
      [selectedCategoryId]: {
        ...current[selectedCategoryId],
        settings: { ...current[selectedCategoryId].settings, [settingId]: value },
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
    setSetting,
    setTargetFolderId,
    setSaveNumber,
  };
}
