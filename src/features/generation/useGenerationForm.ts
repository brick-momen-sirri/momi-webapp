import { useEffect, useMemo, useState } from "react";

import { defaultArchVizGridOptions } from "../../components/archVizGridDefaults";
import { fallbackModelCatalog } from "../../data/modelCatalog";
import type { AuthUser } from "../../services/backendApi";
import { klingPromptOverflowCharacters } from "../../services/promptRules";
import type { ArchVizGridOptions, ModelType, Project, UploadedImage, UploadedVideo } from "../../types";
import { estimateModelCreditLabel, estimateModelCredits } from "../../utils/creditEstimator";
import { useResetWhenChanged } from "../../utils/useResetWhenChanged";
import { hasViewOnlyProjectAccess } from "../projects/projectAccess";
import type { PersistedGenerationSettings } from "../preferences/appPreferences";
import { writePersistedGenerationSettings } from "../preferences/appPreferences";
import {
  defaultDurationSecondsForModel,
  getDisabledReason,
  imageSlotCountForModel,
  isDemoAccount,
  minimumImageCountForModel,
  normalizeDurationSeconds,
  normalizeNanoBananaAspectRatio,
  normalizeResolutionForModel,
  normalizeSaveNumber,
  normalizeSeedanceRatio,
  supports16By9CropToggle,
  supportsImageOutputCount,
} from "./generationUtils";

type GenerationFormOptions = {
  initialSettings: PersistedGenerationSettings;
  models: ModelType[];
  account: AuthUser | null;
  selectedProjectId: string;
  selectedProject?: Project;
  targetFolderId: string;
  creditsRemaining: number;
};

export function useGenerationForm(options: GenerationFormOptions) {
  const { initialSettings, models, account, selectedProjectId, selectedProject, targetFolderId, creditsRemaining } = options;
  const [selectedModelId, setSelectedModelId] = useState(initialSettings.selectedModelId ?? "google_veo");
  const [selectedResolution, setSelectedResolution] = useState(initialSettings.selectedResolution ?? "1080p");
  const [selectedNanoBananaAspectRatio, setSelectedNanoBananaAspectRatio] = useState(
    normalizeNanoBananaAspectRatio(initialSettings.selectedNanoBananaAspectRatio),
  );
  const [selectedSeedanceRatio, setSelectedSeedanceRatio] = useState(normalizeSeedanceRatio(initialSettings.selectedSeedanceRatio));
  const [selectedDurationSeconds, setSelectedDurationSeconds] = useState(initialSettings.selectedDurationSeconds ?? 8);
  const [prompt, setPrompt] = useState(initialSettings.prompt ?? "");
  const [archVizGridOptions, setArchVizGridOptions] = useState<ArchVizGridOptions>(defaultArchVizGridOptions);
  const [saveNumber, setSaveNumber] = useState(normalizeSaveNumber(initialSettings.saveNumber));
  const [imageOutputCount, setImageOutputCount] = useState<1 | 2>(
    initialSettings.imageOutputCount ?? initialSettings.nanoBananaOutputCount ?? 1,
  );
  const [enableImageToVideo16By9Cropping, setEnableImageToVideo16By9Cropping] = useState(
    initialSettings.imageToVideo16By9Cropping ?? true,
  );
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [video, setVideo] = useState<UploadedVideo | undefined>();

  const allowSeedance4K = account?.role === "admin";
  const selectedModelBase = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? models[0] ?? fallbackModelCatalog[0],
    [models, selectedModelId],
  );
  const selectedModel = useMemo(
    () => ({
      ...selectedModelBase,
      cost: estimateModelCredits(selectedModelBase, selectedDurationSeconds, selectedResolution, imageOutputCount),
      costLabel: estimateModelCreditLabel(selectedModelBase, selectedDurationSeconds, selectedResolution, imageOutputCount),
    }),
    [imageOutputCount, selectedDurationSeconds, selectedModelBase, selectedResolution],
  );
  const requiredImages = imageSlotCountForModel(selectedModel);
  const minimumRequiredImages = minimumImageCountForModel(selectedModel);
  const uploadedImages = images.slice(0, requiredImages).filter(Boolean);
  const selectedModelSupportsCropToggle = supports16By9CropToggle(selectedModel);
  const use16By9Cropping = !selectedModelSupportsCropToggle || enableImageToVideo16By9Cropping;
  const viewOnlyProject = hasViewOnlyProjectAccess(account, selectedProject);
  const disabledReason = getDisabledReason({
    isDemoAccount: Boolean(account && isDemoAccount(account)),
    hasViewOnlyProjectAccess: viewOnlyProject,
    insufficientCredits: creditsRemaining < selectedModel.cost,
    selectedProjectId,
    selectedProject,
    hasMissingImages: uploadedImages.length < minimumRequiredImages,
    hasMissingVideo: Boolean(selectedModel.requiresVideo && !video),
    hasCropIssues: Boolean(
      selectedModel.requiresLandscape && use16By9Cropping && uploadedImages.some((image) => image.cropRequired),
    ),
    hasMissingPrompt: selectedModel.requiresPrompt !== false && !prompt.trim(),
    promptOverflowCharacters: klingPromptOverflowCharacters(selectedModel, prompt),
    requiredImages: minimumRequiredImages,
  });

  useResetWhenChanged(`${selectedModel.id}:${allowSeedance4K}`, () => {
    setSelectedDurationSeconds((current) => normalizeDurationSeconds(current, selectedModel));
    setSelectedResolution((current) => normalizeResolutionForModel(current, selectedModel, allowSeedance4K));
  });

  useResetWhenChanged(selectedModelBase.id, () => {
    if (!supportsImageOutputCount(selectedModelBase)) setImageOutputCount(1);
  });

  useEffect(() => {
    writePersistedGenerationSettings({
      selectedModelId,
      selectedResolution,
      selectedNanoBananaAspectRatio,
      selectedSeedanceRatio,
      selectedDurationSeconds,
      selectedProjectId,
      targetFolderId,
      prompt,
      saveNumber,
      imageOutputCount,
      imageToVideo16By9Cropping: enableImageToVideo16By9Cropping,
    });
  }, [
    enableImageToVideo16By9Cropping,
    imageOutputCount,
    prompt,
    saveNumber,
    selectedDurationSeconds,
    selectedModelId,
    selectedNanoBananaAspectRatio,
    selectedProjectId,
    selectedResolution,
    selectedSeedanceRatio,
    targetFolderId,
  ]);

  function handleModelChange(modelId: string) {
    const nextModel = models.find((model) => model.id === modelId);
    setSelectedModelId(modelId);
    if (nextModel) {
      setSelectedResolution((resolution) => normalizeResolutionForModel(resolution, nextModel, allowSeedance4K));
      setSelectedDurationSeconds(defaultDurationSecondsForModel(nextModel));
      if (supportsImageOutputCount(nextModel)) setImageOutputCount(1);
    }
    if (!nextModel?.requiresImage && !nextModel?.requiresTwoImages && !nextModel?.imageSlotCount) setImages([]);
    else setImages((current) => current.slice(0, imageSlotCountForModel(nextModel)));
    if (!nextModel?.requiresVideo) setVideo(undefined);
  }

  function handleResolutionChange(resolution: string) {
    setSelectedResolution(normalizeResolutionForModel(resolution, selectedModel, allowSeedance4K));
  }

  return {
    selectedModelId,
    setSelectedModelId,
    selectedResolution,
    setSelectedResolution,
    selectedNanoBananaAspectRatio,
    setSelectedNanoBananaAspectRatio,
    selectedSeedanceRatio,
    setSelectedSeedanceRatio,
    selectedDurationSeconds,
    setSelectedDurationSeconds,
    prompt,
    setPrompt,
    archVizGridOptions,
    setArchVizGridOptions,
    saveNumber,
    setSaveNumber,
    imageOutputCount,
    setImageOutputCount,
    enableImageToVideo16By9Cropping,
    setEnableImageToVideo16By9Cropping,
    images,
    setImages,
    video,
    setVideo,
    selectedModel,
    selectedModelSupportsCropToggle,
    requiredImages,
    use16By9Cropping,
    disabledReason,
    viewOnlyProject,
    allowSeedance4K,
    handleModelChange,
    handleResolutionChange,
  };
}
