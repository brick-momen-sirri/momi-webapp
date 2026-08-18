import { Eye } from "lucide-react";
import type { SubmissionPhase } from "../features/jobs/useJobSubmission";
import type { ArchVizGridOptions, ModelType, Project, UploadedImage, UploadedVideo } from "../types";
import { ArchVizGridControls } from "./ArchVizGridControls";
import { DurationSelector } from "./DurationSelector";
import { GenerateButton } from "./GenerateButton";
import { ImageUploader } from "./ImageUploader";
import { ModelSelector } from "./ModelSelector";
import { PromptBox } from "./PromptBox";
import { ResolutionSelector } from "./ResolutionSelector";
import { ResultDestinationControl } from "./ResultDestinationControl";
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
  selectedSeedanceRatio: string;
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
  viewOnly?: boolean;
  isSubmitting: boolean;
  submissionPhase: SubmissionPhase;
  hasRecoverableSubmission: boolean;
  onModelChange: (modelId: string) => void;
  onResolutionChange: (resolution: string) => void;
  onNanoBananaAspectRatioChange: (aspectRatio: string) => void;
  onSeedanceRatioChange: (ratio: string) => void;
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
  onCancelSubmission: () => void;
};

export function LeftSettingsPanel({
  models,
  selectedModel,
  selectedProject,
  targetFolderId,
  selectedResolution,
  allowSeedance4K,
  selectedNanoBananaAspectRatio,
  selectedSeedanceRatio,
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
  viewOnly = false,
  isSubmitting,
  submissionPhase,
  hasRecoverableSubmission,
  onModelChange,
  onResolutionChange,
  onNanoBananaAspectRatioChange,
  onSeedanceRatioChange,
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
  onCancelSubmission,
}: LeftSettingsPanelProps) {
  const showResolution = selectedModel.category === "video" || isNanoBananaModel(selectedModel) || isGptImageModel(selectedModel);
  const showArchVizGridControls = isArchVizGridModel(selectedModel);
  const use16By9Cropping = !show16By9CropToggle || enable16By9Cropping;
  const promptImages = use16By9Cropping ? images : images.map((image) => (image ? { ...image, croppedUrl: undefined } : image));

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
          seedanceRatio={selectedSeedanceRatio}
          onSeedanceRatioChange={onSeedanceRatioChange}
          imageOutputCount={imageOutputCount}
          onImageOutputCountChange={onImageOutputCountChange}
        />
      ) : null}
      <DurationSelector selectedModel={selectedModel} value={selectedDurationSeconds} onChange={onDurationChange} />
      {viewOnly ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-800"
        >
          <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            View-only access to {selectedProject?.name ?? "this project"}. Ask a project owner for editor access before preparing
            a job here.
          </span>
        </p>
      ) : null}
      {/* One disabled fieldset rather than a `disabled` prop threaded through every
          control: the browser disables all descendant form controls, so a new input
          added inside is covered without being remembered. ImageUploader still needs
          its own flag for drop and paste, which are not form-control events. */}
      <fieldset disabled={viewOnly} className="min-w-0 space-y-3 disabled:opacity-60">
        <ImageUploader
          images={images}
          onChange={onImagesChange}
          disabled={viewOnly}
          selectedResolution={selectedResolution}
          requiresTwoImages={Boolean(selectedModel.requiresTwoImages)}
          imageSlotCount={
            selectedModel.imageSlotCount ?? (selectedModel.requiresTwoImages ? 2 : selectedModel.requiresImage ? 1 : 0)
          }
          requiresLandscape={Boolean(selectedModel.requiresLandscape)}
          enable16By9Cropping={enable16By9Cropping}
          show16By9CropToggle={show16By9CropToggle}
          onEnable16By9CroppingChange={onEnable16By9CroppingChange}
          textOnly={(selectedModel.imageSlotCount ?? 0) === 0 && !selectedModel.requiresImage && !selectedModel.requiresTwoImages}
        />
        {selectedModel.requiresVideo ? <VideoUploader video={video} onChange={onVideoChange} /> : null}
        {showArchVizGridControls ? (
          <ArchVizGridControls value={archVizGridOptions} onChange={onArchVizGridOptionsChange} />
        ) : (
          <PromptBox value={prompt} onChange={onPromptChange} images={promptImages} selectedModel={selectedModel} />
        )}

        <SaveNumberControl selectedModel={selectedModel} value={saveNumber} onChange={onSaveNumberChange} />

        <ResultDestinationControl
          selectedProject={selectedProject}
          targetFolderId={targetFolderId}
          onTargetFolderChange={onTargetFolderChange}
        />

        <GenerateButton
          selectedModel={selectedModel}
          creditsRemaining={creditsRemaining}
          disabledReason={disabledReason}
          isSubmitting={isSubmitting}
          submissionPhase={submissionPhase}
          hasRecoverableSubmission={hasRecoverableSubmission}
          onGenerate={onGenerate}
          onCancelSubmission={onCancelSubmission}
        />
      </fieldset>
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
