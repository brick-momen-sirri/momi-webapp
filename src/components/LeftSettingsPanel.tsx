import { AlertCircle, FolderCheck } from "lucide-react";
import type { ArchVizGridOptions, ModelType, Project, UploadedImage, UploadedVideo } from "../types";
import { ArchVizGridControls } from "./ArchVizGridControls";
import { DurationSelector } from "./DurationSelector";
import { GenerateButton } from "./GenerateButton";
import { ImageUploader } from "./ImageUploader";
import { ModelSelector } from "./ModelSelector";
import { PromptBox } from "./PromptBox";
import { ResolutionSelector } from "./ResolutionSelector";
import { SaveNumberControl } from "./SaveNumberControl";
import { VideoUploader } from "./VideoUploader";

type LeftSettingsPanelProps = {
  models: ModelType[];
  selectedModel: ModelType;
  selectedProject?: Project;
  targetFolderId: string;
  selectedResolution: string;
  allowSeedance4K: boolean;
  selectedNanoBananaAspectRatio: string;
  selectedDurationSeconds: number;
  prompt: string;
  archVizGridOptions: ArchVizGridOptions;
  saveNumber: string;
  imageOutputCount: 1 | 2;
  enable16By9Cropping: boolean;
  show16By9CropToggle: boolean;
  images: UploadedImage[];
  video?: UploadedVideo;
  creditsRemaining: number;
  disabledReason?: string;
  isSubmitting: boolean;
  onModelChange: (modelId: string) => void;
  onResolutionChange: (resolution: string) => void;
  onNanoBananaAspectRatioChange: (aspectRatio: string) => void;
  onDurationChange: (seconds: number) => void;
  onPromptChange: (prompt: string) => void;
  onArchVizGridOptionsChange: (options: ArchVizGridOptions) => void;
  onTargetFolderChange: (folderId: string) => void;
  onSaveNumberChange: (value: string) => void;
  onImageOutputCountChange: (value: 1 | 2) => void;
  onEnable16By9CroppingChange: (enabled: boolean) => void;
  onImagesChange: (images: UploadedImage[]) => void;
  onVideoChange: (video: UploadedVideo | undefined) => void;
  onGenerate: () => void;
};

export function LeftSettingsPanel({
  models,
  selectedModel,
  selectedProject,
  targetFolderId,
  selectedResolution,
  allowSeedance4K,
  selectedNanoBananaAspectRatio,
  selectedDurationSeconds,
  prompt,
  archVizGridOptions,
  saveNumber,
  imageOutputCount,
  enable16By9Cropping,
  show16By9CropToggle,
  images,
  video,
  creditsRemaining,
  disabledReason,
  isSubmitting,
  onModelChange,
  onResolutionChange,
  onNanoBananaAspectRatioChange,
  onDurationChange,
  onPromptChange,
  onArchVizGridOptionsChange,
  onTargetFolderChange,
  onSaveNumberChange,
  onImageOutputCountChange,
  onEnable16By9CroppingChange,
  onImagesChange,
  onVideoChange,
  onGenerate,
}: LeftSettingsPanelProps) {
  const showResolution = selectedModel.category === "video" || isNanoBananaModel(selectedModel) || isGptImageModel(selectedModel);
  const showArchVizGridControls = isArchVizGridModel(selectedModel);
  const use16By9Cropping = !show16By9CropToggle || enable16By9Cropping;
  const promptImages = use16By9Cropping
    ? images
    : images.map((image) => image ? { ...image, croppedUrl: undefined } : image);
  const activeFolders = (selectedProject?.folders ?? []).filter((folder) => !folder.archived);
  const targetFolder = activeFolders.find((folder) => folder.folderId === targetFolderId);

  return (
    <div className="space-y-3 pb-3">
      <ModelSelector models={models} selectedModel={selectedModel} onChange={onModelChange} />
      {showResolution ? (
        <ResolutionSelector
          selectedModel={selectedModel}
          value={selectedResolution}
          onChange={onResolutionChange}
          allowSeedance4K={allowSeedance4K}
          aspectRatio={selectedNanoBananaAspectRatio}
          onAspectRatioChange={onNanoBananaAspectRatioChange}
          imageOutputCount={imageOutputCount}
          onImageOutputCountChange={onImageOutputCountChange}
        />
      ) : null}
      <DurationSelector
        selectedModel={selectedModel}
        value={selectedDurationSeconds}
        onChange={onDurationChange}
      />
      <ImageUploader
        images={images}
        onChange={onImagesChange}
        selectedResolution={selectedResolution}
        requiresTwoImages={Boolean(selectedModel.requiresTwoImages)}
        imageSlotCount={selectedModel.imageSlotCount ?? (selectedModel.requiresTwoImages ? 2 : selectedModel.requiresImage ? 1 : 0)}
        requiresLandscape={Boolean(selectedModel.requiresLandscape)}
        enable16By9Cropping={enable16By9Cropping}
        show16By9CropToggle={show16By9CropToggle}
        onEnable16By9CroppingChange={onEnable16By9CroppingChange}
        textOnly={(selectedModel.imageSlotCount ?? 0) === 0 && !selectedModel.requiresImage && !selectedModel.requiresTwoImages}
      />
      {selectedModel.requiresVideo ? (
        <VideoUploader video={video} onChange={onVideoChange} />
      ) : null}
      {showArchVizGridControls ? (
        <ArchVizGridControls value={archVizGridOptions} onChange={onArchVizGridOptionsChange} />
      ) : (
        <PromptBox value={prompt} onChange={onPromptChange} images={promptImages} selectedModel={selectedModel} />
      )}

      <SaveNumberControl
        selectedModel={selectedModel}
        value={saveNumber}
        onChange={onSaveNumberChange}
      />

      {selectedProject ? (
        <label className="block rounded-lg border border-line bg-white p-3 shadow-panel">
          <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">Save result to</span>
          <select
            value={targetFolderId}
            onChange={(event) => onTargetFolderChange(event.target.value)}
            className="mt-2 h-10 w-full rounded-md border border-line bg-white px-3 text-sm font-semibold outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
          >
            <option value="">Root</option>
            {activeFolders.map((folder) => (
              <option key={folder.folderId} value={folder.folderId}>
                {folder.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className={`rounded-lg border p-3 shadow-panel ${selectedProject ? "border-teal-100 bg-teal-50" : "border-amber-200 bg-amber-50"}`}>
        <div className="flex items-start gap-2">
          {selectedProject ? (
            <FolderCheck className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
          ) : (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" />
          )}
          <div>
            <p className={`text-xs font-semibold ${selectedProject ? "text-teal-800" : "text-amber-900"}`}>
              {selectedProject
                ? `Saving to ${selectedProject.shortName}_${selectedProject.name.replaceAll(" ", "_")}${targetFolder ? ` / ${targetFolder.name}` : ""}`
                : "Please select a specific project before generating."}
            </p>
            <p className={`mt-1 text-xs leading-5 ${selectedProject ? "text-teal-700" : "text-amber-800"}`}>
              Every result is stored with jobs, inputs, results, thumbnails, and metadata in the selected project folder.
            </p>
          </div>
        </div>
      </div>

      <GenerateButton
        selectedModel={selectedModel}
        creditsRemaining={creditsRemaining}
        disabledReason={disabledReason}
        isSubmitting={isSubmitting}
        onGenerate={onGenerate}
      />
    </div>
  );
}

function isArchVizGridModel(model: ModelType) {
  const key = `${model.id} ${model.label} ${model.workflowPath ?? ""}`.toLowerCase();
  return key.includes("exteriorgrid") || key.includes("exterior grid");
}

function isNanoBananaModel(model: ModelType) {
  const key = `${model.id} ${model.label} ${model.backendCategory ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  return key.includes("nano") && key.includes("banana");
}

function isGptImageModel(model: ModelType) {
  const key = `${model.id} ${model.label} ${model.backendCategory ?? ""} ${model.workflowPath ?? ""}`.toLowerCase();
  return (key.includes("openai_gpt_image_2_i2i") || key.includes("gpt_image")) && !key.includes("exteriorgrid");
}
