import { CheckCircle2, Dices, ImageIcon, Info, LockKeyhole, Minus, Play, Plus, SlidersHorizontal } from "lucide-react";
import type { Project, UploadedImage } from "../types";
import { cn } from "../utils/classNames";
import { randomStillImageSeedValue, stepStillImageSeed } from "../features/still-images/seed";
import {
  STILL_IMAGE_CATEGORIES,
  shouldShowStillImagePrompt,
  stillImageModeGuidance,
  stillImageSlotCount,
  stillImageSlotLabels,
  visibleStillImageSettings,
  type StillImageCategoryDefinition,
  type StillImageCategoryId,
  type StillImageCategoryState,
  type StillImageSettingDefinition,
  type StillImageSettingValue,
} from "../features/still-images/stillImageCategories";
import { ImageUploader } from "./ImageUploader";
import { ResultDestinationControl } from "./ResultDestinationControl";
import { ResultNamingControl } from "./ResultNamingControl";

type StillImagesSettingsPanelProps = {
  selectedCategoryId: StillImageCategoryId;
  category: StillImageCategoryDefinition;
  state: StillImageCategoryState;
  selectedProject?: Project;
  targetFolderId: string;
  saveNumber: string;
  onCategoryChange: (categoryId: StillImageCategoryId) => void;
  onImagesChange: (images: UploadedImage[]) => void;
  onPromptChange: (prompt: string) => void;
  onSeedChange: (seed: string) => void;
  onSettingChange: (settingId: string, value: StillImageSettingValue) => void;
  onTargetFolderChange: (folderId: string) => void;
  onSaveNumberChange: (value: string) => void;
  onGenerate: () => void;
  submitting?: boolean;
  submitError?: string;
};

export function StillImagesSettingsPanel({
  selectedCategoryId,
  category,
  state,
  selectedProject,
  targetFolderId,
  saveNumber,
  onCategoryChange,
  onImagesChange,
  onPromptChange,
  onSeedChange,
  onSettingChange,
  onTargetFolderChange,
  onSaveNumberChange,
  onGenerate,
  submitting = false,
  submitError,
}: StillImagesSettingsPanelProps) {
  const CategoryIcon = category.icon;
  const imageSlotCount = stillImageSlotCount(category, state);
  const slotLabels = stillImageSlotLabels(category, state);
  const showPrompt = shouldShowStillImagePrompt(category, state);
  const modeGuidance = stillImageModeGuidance(category, state);
  const requiredImagesReady = Array.from({ length: imageSlotCount }, (_, index) => state.images[index]).every(Boolean);
  const readyToGenerate = requiredImagesReady && Boolean(selectedProject);
  const settingsCard = (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <div className="mb-3 flex items-center gap-2">
        <SlidersHorizontal className="h-4 w-4 text-stone-500" />
        <h2 className="text-sm font-semibold">Settings</h2>
      </div>
      <div className="space-y-3">
        {visibleStillImageSettings(category, state).map((setting) => (
          <StillImageSettingField
            key={setting.id}
            setting={setting}
            value={state.settings[setting.id] ?? setting.defaultValue}
            onChange={(value) => onSettingChange(setting.id, value)}
          />
        ))}
      </div>
      {modeGuidance ? (
        <div className="mt-3 rounded-md bg-cyan-50 px-3 py-2 text-xs leading-5 text-cyan-800">
          <p className="font-bold">{modeGuidance.title}</p>
          <p className="mt-1">{modeGuidance.description}</p>
        </div>
      ) : null}
    </section>
  );

  return (
    <div className="space-y-3 pb-3">
      <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
        <div className="mb-3 flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold">Still Image Workflow</h2>
        </div>

        <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Category</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {STILL_IMAGE_CATEGORIES.map((option) => {
            const Icon = option.icon;
            const selected = option.id === selectedCategoryId;

            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onCategoryChange(option.id)}
                aria-pressed={selected}
                className={cn(
                  "group flex min-h-[62px] items-center gap-2 rounded-md border px-2.5 py-2 text-left transition",
                  selected
                    ? "border-accent bg-accent text-white shadow-card"
                    : "border-line bg-white text-stone-700 hover:border-accent hover:bg-mist",
                )}
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border",
                    selected
                      ? "border-white/25 bg-white/15 text-white"
                      : "border-line bg-stone-50 text-stone-600 group-hover:border-accent group-hover:text-accent",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-bold leading-4">{option.label}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 rounded-md border border-line bg-mist/70 p-3">
          <div className="flex gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-ink text-white">
              <CategoryIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">{category.label}</p>
              <p className="mt-1 text-xs leading-5 text-stone-600">{category.shortDescription}</p>
            </div>
          </div>
          <p className="mt-3 text-xs leading-5 text-stone-600">{category.instructions}</p>
        </div>
      </section>

      {category.id === "qwen-edit" ? settingsCard : null}

      <ImageUploader
        images={state.images}
        onChange={onImagesChange}
        selectedResolution="1024x1024"
        requiresTwoImages={false}
        imageSlotCount={imageSlotCount}
        requiresLandscape={false}
        enable16By9Cropping={false}
        show16By9CropToggle={false}
        onEnable16By9CroppingChange={() => undefined}
        textOnly={false}
        frontendOnly
        slotLabels={slotLabels}
      />

      {showPrompt && category.prompt ? (
        <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
          <div className="mb-3 flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-stone-500" />
            <h2 className="text-sm font-semibold">{category.prompt.label}</h2>
          </div>
          <textarea
            aria-label={category.prompt.label}
            value={state.prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            placeholder={category.prompt.placeholder}
            rows={5}
            className="w-full resize-y rounded-md border border-line bg-white px-3 py-2 text-sm leading-6 text-ink outline-none transition placeholder:text-stone-400 focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          <p className="mt-2 text-xs leading-5 text-stone-500">{category.prompt.hint}</p>
        </section>
      ) : null}

      {category.id !== "qwen-edit" ? settingsCard : null}

      {/* Empty is the normal state: the server draws a seed and records it on the
          job. A value here is almost always one restored from an earlier result
          through Reuse settings, to render that take again. */}
      <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
        <div className="mb-3 flex items-center gap-2">
          <Dices className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold">Seed</h2>
        </div>
        <input
          type="text"
          inputMode="numeric"
          aria-label="Seed"
          value={state.seed}
          onChange={(event) => onSeedChange(event.target.value)}
          placeholder="New seed each run"
          className="h-10 w-full min-w-0 rounded-md border border-line bg-white px-3 font-mono text-sm outline-none transition placeholder:font-sans placeholder:text-stone-400 focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
        {/* Pin, walk, release. Exploring a setting around one take used to mean
            reading the seed off a finished card and retyping it here, because the only
            control was Clear and the only other way to fill the field was Reuse
            settings on a job that had already run. */}
        <div className="mt-2 flex gap-2">
          <SeedButton label="Random" onClick={() => onSeedChange(randomStillImageSeedValue())}>
            <Dices className="h-3.5 w-3.5" />
            Random
          </SeedButton>
          <SeedButton
            label="Previous seed"
            disabled={!state.seed}
            onClick={() => onSeedChange(stepStillImageSeed(state.seed, -1))}
          >
            <Minus className="h-3.5 w-3.5" />
          </SeedButton>
          <SeedButton label="Next seed" disabled={!state.seed} onClick={() => onSeedChange(stepStillImageSeed(state.seed, 1))}>
            <Plus className="h-3.5 w-3.5" />
          </SeedButton>
          <SeedButton label="Clear seed" disabled={!state.seed} onClick={() => onSeedChange("")}>
            Clear
          </SeedButton>
        </div>
        <p className="mt-2 text-xs leading-5 text-stone-500">
          {state.seed
            ? "This exact seed will be used, so the same inputs and settings reproduce that render. Stepping moves to a neighbouring take, which is a different render, not a nudged one."
            : "A new seed is drawn for each run and saved on the result, so any render can be reproduced later."}
        </p>
      </section>

      <ResultNamingControl label="Camera number" value={saveNumber} onChange={onSaveNumberChange} />
      <ResultDestinationControl
        selectedProject={selectedProject}
        targetFolderId={targetFolderId}
        onTargetFolderChange={onTargetFolderChange}
      />

      <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
        <div
          className={cn(
            "mb-3 flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-5",
            submitError
              ? "bg-rose-50 text-rose-800"
              : readyToGenerate
                ? "bg-teal-50 text-teal-800"
                : "bg-amber-50 text-amber-800",
          )}
          role="status"
        >
          {readyToGenerate && !submitError ? (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span>
            {submitError
              ? submitError
              : readyToGenerate
                ? "Inputs are ready."
                : `Add ${!requiredImagesReady ? "the required image input" : "a project destination"} to generate.`}
          </span>
        </div>
        <button
          type="button"
          disabled={!readyToGenerate || submitting}
          onClick={onGenerate}
          className={cn(
            "flex h-12 w-full items-center justify-center gap-2 rounded-md px-4 text-sm font-bold text-white transition",
            readyToGenerate && !submitting
              ? "cursor-pointer bg-accent hover:brightness-105"
              : "cursor-not-allowed bg-stone-300 opacity-80",
          )}
        >
          <Play className="h-4 w-4" />
          {submitting ? "Sending..." : "Generate"}
        </button>
        <p className="mt-2 flex min-h-5 items-center gap-1.5 text-xs leading-5 text-stone-500">
          {readyToGenerate ? null : <LockKeyhole className="h-3.5 w-3.5" />}
          {readyToGenerate ? "Runs on this preset's dedicated pod." : "Complete the inputs above to enable generation."}
        </p>
      </section>
    </div>
  );
}

/**
 * One of the seed field's actions.
 *
 * `label` is the accessible name, so the icon-only steppers announce themselves as
 * something other than an unlabelled button.
 */
function SeedButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border px-2 text-xs font-semibold transition",
        disabled
          ? "cursor-not-allowed border-line bg-stone-50 text-stone-300"
          : "border-line bg-white text-stone-700 hover:border-accent hover:text-accent",
      )}
    >
      {children}
    </button>
  );
}

type StillImageSettingFieldProps = {
  setting: StillImageSettingDefinition;
  value: StillImageSettingValue;
  onChange: (value: StillImageSettingValue) => void;
};

function StillImageSettingField({ setting, value, onChange }: StillImageSettingFieldProps) {
  if (setting.kind === "checkbox") {
    return (
      <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-line bg-stone-50 px-3 text-xs font-semibold text-stone-700">
        <span>{setting.label}</span>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4 accent-accent"
        />
      </label>
    );
  }

  if (setting.kind === "select") {
    return (
      <label className="block">
        <span className="text-xs font-semibold text-stone-600">{setting.label}</span>
        <select
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1.5 h-10 w-full rounded-md border border-line bg-white px-3 text-sm font-semibold outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
        >
          {setting.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {setting.hint ? <span className="mt-1 block text-[11px] text-stone-500">{setting.hint}</span> : null}
      </label>
    );
  }

  return (
    <label className="block rounded-md border border-line bg-stone-50 px-3 py-2.5">
      <span className="flex items-center justify-between gap-3 text-xs font-semibold text-stone-600">
        {setting.label}
        <output className="rounded bg-white px-2 py-0.5 font-bold text-ink">{Number(value)}</output>
      </span>
      <input
        type="range"
        value={Number(value)}
        min={setting.minimum}
        max={setting.maximum}
        step={setting.step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 w-full accent-accent"
      />
    </label>
  );
}
