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
import {
  defaultSeedanceVideoEditing,
  normalizeSeedanceVersion,
  seedanceEffectiveModel,
  seedanceSupportsVideoEditing,
  seedanceVersion,
} from "./seedanceVersions";

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
  const [selectedSeedanceRatio, setSelectedSeedanceRatio] = useState(
    normalizeSeedanceRatio(initialSettings.selectedSeedanceRatio),
  );
  const [selectedSeedanceVersion, setSelectedSeedanceVersion] = useState(
    normalizeSeedanceVersion(initialSettings.selectedSeedanceVersion),
  );
  const [seedanceVideoEditing, setSeedanceVideoEditing] = useState(initialSettings.seedanceVideoEditing ?? false);
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
  // The version is folded into the model here rather than threaded through each
  // control: a Seedance model's resolutions and durations come from the version, not
  // from its workflow file, so overriding them in one place leaves the resolution
  // picker, the duration slider, the credit estimate and the reuse normalisers
  // correct without any of them knowing that Seedance has versions.
  const versionedModelBase = useMemo(
    () => seedanceEffectiveModel(selectedModelBase, selectedSeedanceVersion),
    [selectedModelBase, selectedSeedanceVersion],
  );
  const selectedModel = useMemo(
    () => ({
      ...versionedModelBase,
      cost: estimateModelCredits(versionedModelBase, selectedDurationSeconds, selectedResolution, imageOutputCount, {
        seedanceVersion: selectedSeedanceVersion,
      }),
      costLabel: estimateModelCreditLabel(versionedModelBase, selectedDurationSeconds, selectedResolution, imageOutputCount, {
        seedanceVersion: selectedSeedanceVersion,
      }),
    }),
    [imageOutputCount, selectedDurationSeconds, selectedResolution, selectedSeedanceVersion, versionedModelBase],
  );
  const selectedModelSupportsVideoEditing = seedanceSupportsVideoEditing(selectedModel, seedanceVersion(selectedSeedanceVersion));
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

  useResetWhenChanged(`${selectedModel.id}:${selectedSeedanceVersion}:${allowSeedance4K}`, () => {
    setSelectedDurationSeconds((current) => normalizeDurationSeconds(current, selectedModel));
    setSelectedResolution((current) => normalizeResolutionForModel(current, selectedModel, allowSeedance4K));
  });

  // Re-derived on every model or version change, like the resolution and duration
  // above: on wherever the switch is offered, off everywhere else. Off on a task
  // with no edit mode would be rejected by the server; off on 2.5 video editing is
  // the setting that failed at the provider -- see defaultSeedanceVideoEditing.
  useResetWhenChanged(`${selectedModel.id}:${selectedSeedanceVersion}`, () => {
    setSeedanceVideoEditing(defaultSeedanceVideoEditing(selectedModel, seedanceVersion(selectedSeedanceVersion)));
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
      selectedSeedanceVersion,
      seedanceVideoEditing,
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
    seedanceVideoEditing,
    selectedDurationSeconds,
    selectedModelId,
    selectedNanoBananaAspectRatio,
    selectedProjectId,
    selectedResolution,
    selectedSeedanceRatio,
    selectedSeedanceVersion,
    targetFolderId,
  ]);

  function handleModelChange(modelId: string) {
    const chosen = models.find((model) => model.id === modelId);
    // Against the version's limits, not the workflow file's: switching to another
    // Seedance task while on 2.5 must not seed a 4K resolution the model cannot run.
    const nextModel = chosen && seedanceEffectiveModel(chosen, selectedSeedanceVersion);
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
    selectedSeedanceVersion,
    setSelectedSeedanceVersion,
    seedanceVideoEditing,
    setSeedanceVideoEditing,
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
    selectedModelSupportsVideoEditing,
    requiredImages,
    use16By9Cropping,
    disabledReason,
    viewOnlyProject,
    allowSeedance4K,
    handleModelChange,
    handleResolutionChange,
  };
}
