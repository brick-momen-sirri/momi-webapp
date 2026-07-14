import {
  AlertTriangle,
  BadgeDollarSign,
  CheckCircle2,
  Clock,
  Film,
  ImageIcon,
  PenTool,
  Scissors,
  SlidersHorizontal,
  Video,
} from "lucide-react";
import type { DragEvent } from "react";
import klingIcon from "../assets/model-icons/kling.png";
import openAiIcon from "../assets/model-icons/openai.png";
import seedanceIcon from "../assets/model-icons/seedance.png";
import veo3Icon from "../assets/model-icons/veo3.png";
import type { ModelType } from "../types";
import { cn } from "../utils/classNames";
import { hasResultImageDragData } from "../utils/resultDrag";

type ModelSelectorProps = {
  models: ModelType[];
  selectedModel: ModelType;
  onChange: (modelId: string) => void;
};

const taskCategories = [
  {
    id: "first_last_frame_to_video",
    label: "Frame to Video",
    shortLabel: "F2V",
    hint: "First + last frame",
    icon: Film,
  },
  {
    id: "image_to_video",
    label: "Image to Video",
    shortLabel: "I2V",
    hint: "Animate an image",
    icon: Video,
  },
  {
    id: "video_editing",
    label: "Video Editing",
    shortLabel: "Edit",
    hint: "Modify footage",
    icon: Scissors,
  },
  {
    id: "image_editing",
    label: "Image Editing",
    shortLabel: "Image",
    hint: "Edit or upscale",
    icon: PenTool,
  },
] as const;

const providerOptions = [
  {
    id: "kling",
    label: "Kling",
    iconSrc: klingIcon,
    aliases: ["kling"],
  },
  {
    id: "seedance",
    label: "Seedance",
    iconSrc: seedanceIcon,
    aliases: ["seedance"],
  },
  {
    id: "veo3",
    label: "Veo 3",
    iconSrc: veo3Icon,
    aliases: ["veo3", "veo 3"],
  },
] as const;

export function ModelSelector({ models, selectedModel, onChange }: ModelSelectorProps) {
  const selectedCategory = categoryForModel(selectedModel) ?? taskCategories[0];
  const CategoryIcon = selectedCategory.icon;
  const categoryModels = models.filter((model) => modelMatchesCategory(model, selectedCategory.id));
  const workflowOptions = workflowCards(categoryModels);

  function activateFromResultDrag(event: DragEvent<HTMLElement>, model?: ModelType) {
    if (!model || !hasResultImageDragData(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";

    if (model.id !== selectedModel.id) {
      onChange(model.id);
    }
  }

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold">Generation Settings</h2>
        </div>
        {selectedModel.requiresLandscape ? (
          <span className="rounded-full bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700">
            16:9 required
          </span>
        ) : null}
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Task category</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {taskCategories.map((category) => {
            const Icon = category.icon;
            const selected = category.id === selectedCategory.id;
            const categoryModel = firstModelForCategory(models, category.id);
            const disabled = !categoryModel;

            return (
              <button
                key={category.id}
                type="button"
                disabled={disabled}
                onClick={() => categoryModel && onChange(categoryModel.id)}
                onDragEnter={(event) => activateFromResultDrag(event, categoryModel)}
                onDragOver={(event) => activateFromResultDrag(event, categoryModel)}
                aria-pressed={selected}
                className={cn(
                  "group flex min-h-[58px] items-center gap-2 rounded-md border px-2.5 py-2 text-left transition",
                  selected
                    ? "border-accent bg-accent text-white shadow-card"
                    : "border-line bg-white text-stone-700 hover:border-accent hover:bg-mist",
                  disabled ? "cursor-not-allowed opacity-45 hover:border-line hover:bg-white" : "cursor-pointer",
                )}
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition",
                    selected
                      ? "border-white/25 bg-white/15 text-white"
                      : "border-line bg-stone-50 text-stone-600 group-hover:border-accent group-hover:text-accent",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-bold">{category.label}</span>
                  <span className={cn("mt-0.5 block truncate text-[11px]", selected ? "text-white/75" : "text-stone-500")}>
                    {category.hint}
                  </span>
                </span>
                <span className="sr-only">{category.shortLabel}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">Workflow</p>
        <div className="flex gap-2">
          {workflowOptions.map((option) => {
            const Icon = "icon" in option ? option.icon : ImageIcon;
            const iconSrc = "iconSrc" in option ? option.iconSrc : undefined;
            const selected = option.model?.id === selectedModel.id;
            const disabled = !option.model;

            return (
              <button
                key={option.id}
                type="button"
                disabled={disabled}
                onClick={() => option.model && onChange(option.model.id)}
                onDragEnter={(event) => activateFromResultDrag(event, option.model)}
                onDragOver={(event) => activateFromResultDrag(event, option.model)}
                aria-pressed={selected}
                aria-label={option.label}
                title={option.model?.workflowPath ? `${option.label} - ${workflowFileName(option.model.workflowPath)}` : `${option.label} unavailable`}
                className={cn(
                  "relative flex h-8 w-8 items-center justify-center rounded-md border transition",
                  selected ? "border-accent bg-accent text-white shadow-card" : "border-line bg-white text-stone-600",
                  disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:border-accent hover:text-accent",
                )}
              >
                {iconSrc ? (
                  <img
                    src={iconSrc}
                    alt=""
                    className={cn("workflow-icon-img h-4 w-4 object-contain", selected ? "workflow-icon-selected brightness-0 invert" : "")}
                  />
                ) : (
                  <Icon className="h-3.5 w-3.5" />
                )}
                {selected ? <CheckCircle2 className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-white text-accent" /> : null}
                <span className="sr-only">{option.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-3 rounded-md border border-line bg-mist/70 p-3">
        <div className="flex gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-ink text-white">
            <CategoryIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">{selectedModel.label}</p>
            <p className="mt-1 text-xs leading-5 text-stone-600">{selectedModel.description}</p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-stone-600">
          <span className="flex items-center gap-1 rounded-md bg-white px-2 py-1.5">
            <BadgeDollarSign className="h-3.5 w-3.5 text-ember" />
            {selectedModel.costLabel ?? `${selectedModel.cost} credits`}
          </span>
          <span className="flex items-center gap-1 rounded-md bg-white px-2 py-1.5">
            <Clock className="h-3.5 w-3.5 text-accent" />
            {selectedModel.estimatedTime}
          </span>
        </div>
      </div>

      <div
        className={cn(
          "mt-3 flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-5",
          selectedModel.requiresVideo
            ? "bg-cyan-50 text-cyan-800"
            : selectedModel.requiresTwoImages
            ? "bg-cyan-50 text-cyan-800"
            : "bg-stone-50 text-stone-600",
        )}
      >
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          {selectedModel.requiresVideo && selectedModel.requiresImage
            ? "This model needs one reference image and one input video before generation."
            : selectedModel.requiresVideo
              ? "This model needs an input video before generation."
              : selectedModel.requiresTwoImages
            ? "This model needs both a start frame and an end frame before generation."
            : "Most jobs use a single reference image or text-only prompt, depending on the model."}
        </span>
      </div>
    </section>
  );
}

function categoryForModel(model: ModelType) {
  return taskCategories.find((category) => category.id === model.backendCategory) ?? (
    model.category === "image" ? taskCategories.find((category) => category.id === "image_editing") : undefined
  );
}

function firstModelForCategory(models: ModelType[], categoryId: string) {
  const categoryModels = models.filter((model) => modelMatchesCategory(model, categoryId));
  const cards = workflowCards(categoryModels);
  return cards.find((card) => card.model)?.model ?? categoryModels[0];
}

function modelMatchesCategory(model: ModelType, categoryId: string) {
  if (model.backendCategory) {
    return model.backendCategory === categoryId;
  }
  if (categoryId === "image_editing") {
    return model.category === "image" || model.category === "upscale";
  }
  return model.category === "video";
}

function workflowCards(categoryModels: ModelType[]) {
  const orderedModels = orderWorkflowModels(categoryModels);
  const providerCards = providerOptions.map((provider) => ({
    ...provider,
    model: bestProviderModel(orderedModels, provider.aliases),
  }));

  if (providerCards.some((card) => card.model)) {
    return providerCards;
  }

  return orderedModels.map((model) => ({
    id: model.id,
    label: cleanModelLabel(model.label),
    icon: ImageIcon,
    iconSrc: iconSrcForModel(model),
    aliases: [model.id],
    model,
  }));
}

function orderWorkflowModels(models: ModelType[]) {
  if (!models.some((model) => modelMatchesCategory(model, "image_editing"))) {
    return models;
  }

  return models
    .map((model, index) => ({ model, index }))
    .sort((a, b) => imageEditingWorkflowRank(a.model) - imageEditingWorkflowRank(b.model) || a.index - b.index)
    .map((entry) => entry.model);
}

function imageEditingWorkflowRank(model: ModelType) {
  const text = `${model.id} ${model.label} ${model.workflowPath ?? ""}`.toLowerCase();
  const isExteriorGrid = text.includes("exteriorgrid") || text.includes("exterior grid");
  if (text.includes("nano") && text.includes("banana")) return 0;
  if ((text.includes("openai") || text.includes("gpt")) && !isExteriorGrid) return 1;
  if (isExteriorGrid) return 2;
  return 50;
}

function bestProviderModel(models: ModelType[], aliases: readonly string[]) {
  return models
    .filter((model) => {
      const text = `${model.id} ${model.label} ${model.workflowPath ?? ""}`.toLowerCase();
      return aliases.some((alias) => text.includes(alias));
    })
    .sort((a, b) => modelScore(b) - modelScore(a))[0];
}

function modelScore(model: ModelType) {
  const text = `${model.id} ${model.label} ${model.workflowPath ?? ""}`.toLowerCase();
  let score = 0;
  if (text.includes("v3") || text.includes("veo3")) score += 20;
  if (text.includes("2.0") || text.includes("2_0")) score += 10;
  return score;
}

function workflowFileName(workflowPath: string) {
  return workflowPath.split(/[\\/]/).pop() ?? workflowPath;
}

function iconSrcForModel(model: ModelType) {
  const text = `${model.id} ${model.label} ${model.workflowPath ?? ""}`.toLowerCase();
  if (text.includes("openai") || text.includes("gpt")) return openAiIcon;
  if (text.includes("kling")) return klingIcon;
  if (text.includes("seedance")) return seedanceIcon;
  if (text.includes("veo") || text.includes("gemini") || text.includes("nano")) return veo3Icon;
  return undefined;
}

function cleanModelLabel(label: string) {
  return label.replace(/^Api\s+/i, "").replace(/\s+/g, " ").trim();
}
