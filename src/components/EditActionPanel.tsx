import { ImagePlus, LoaderCircle, Sparkles, WandSparkles, X } from "lucide-react";
import { useRef } from "react";

import type { StillImageEditMode, UploadedImage } from "../types";
import { createClientId } from "../utils/id";
import { revokeImageObjectUrls } from "../utils/uploadedImage";
import { cn } from "../utils/classNames";

type EditActionPanelProps = {
  mode: StillImageEditMode;
  prompt: string;
  references: UploadedImage[];
  variations: number;
  regenerating: boolean;
  submitting: boolean;
  error?: string;
  canGenerate: boolean;
  disabledReason?: string;
  onModeChange: (mode: StillImageEditMode) => void;
  onPromptChange: (prompt: string) => void;
  onReferencesChange: (references: UploadedImage[]) => void;
  onVariationsChange: (variations: number) => void;
  onGenerate: () => void;
};

const MAX_REFERENCES = 3;

export function EditActionPanel({
  mode,
  prompt,
  references,
  variations,
  regenerating,
  submitting,
  error,
  canGenerate,
  disabledReason,
  onModeChange,
  onPromptChange,
  onReferencesChange,
  onVariationsChange,
  onGenerate,
}: EditActionPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const referencesSupported = mode === "inpaint";

  function addFiles(files: FileList | null) {
    if (!files || !referencesSupported) return;
    const available = Math.max(0, MAX_REFERENCES - references.length);
    const additions = Array.from(files)
      .filter((file) => file.type.startsWith("image/") || /\.(avif|gif|jpe?g|png|webp)$/i.test(file.name))
      .slice(0, available)
      .map((file) => ({ id: createClientId("editref_"), name: file.name, url: URL.createObjectURL(file) }));
    if (additions.length) onReferencesChange([...references, ...additions]);
  }

  function removeReference(reference: UploadedImage) {
    revokeImageObjectUrls(reference);
    onReferencesChange(references.filter((candidate) => candidate.id !== reference.id));
  }

  return (
    <section
      className="w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-white/70 bg-white/95 p-3 text-stone-900 shadow-2xl shadow-stone-950/20 backdrop-blur"
      aria-label="Edit prompt and generation"
      aria-busy={submitting}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-bold">Describe this edit</h2>
        <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-stone-400">
          {regenerating ? "Existing layer" : "New layer"}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-1" aria-label="Edit mode">
        {(["inpaint", "enhance"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            disabled={submitting}
            onClick={() => onModeChange(option)}
            className={cn(
              "h-9 rounded-md text-xs font-bold capitalize transition",
              mode === option ? "bg-white text-ink shadow-sm" : "text-stone-500 hover:text-ink",
              submitting && "cursor-not-allowed opacity-50",
            )}
          >
            {option}
          </button>
        ))}
      </div>

      <label className="mt-3 block text-xs font-semibold text-stone-600">
        Prompt
        <textarea
          value={prompt}
          disabled={submitting}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder={
            mode === "enhance" ? "Describe the detail or quality to improve…" : "Describe what should replace the selected area…"
          }
          rows={3}
          className="mt-1.5 w-full resize-none rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm leading-5 outline-none transition placeholder:text-stone-400 focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:bg-stone-50 disabled:text-stone-500"
        />
      </label>

      <div className="mt-3 flex items-center gap-2">
        <span className="text-xs font-semibold text-stone-600">References</span>
        <span className="text-[10px] text-stone-400">
          {references.length}/{MAX_REFERENCES}
        </span>
        {!referencesSupported ? <span className="ml-auto text-[10px] font-medium text-amber-700">Used by Inpaint</span> : null}
      </div>

      <div className="mt-1.5 flex min-h-14 gap-2 overflow-x-auto rounded-lg border border-stone-200 bg-stone-50 p-2">
        {references.map((reference) => (
          <div
            key={reference.id}
            className="group relative h-12 w-16 shrink-0 overflow-hidden rounded-md border border-stone-200 bg-white"
          >
            <img src={reference.previewUrl ?? reference.url} alt={reference.name} className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => removeReference(reference)}
              disabled={submitting}
              aria-label={`Remove ${reference.name}`}
              className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-stone-950/75 text-white opacity-0 transition group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {references.length < MAX_REFERENCES ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={!referencesSupported || submitting}
            className="flex h-12 w-16 shrink-0 flex-col items-center justify-center rounded-md border border-dashed border-stone-300 text-[9px] font-semibold text-stone-500 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ImagePlus className="mb-0.5 h-4 w-4" />
            Add
          </button>
        ) : null}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          disabled={submitting}
          className="hidden"
          aria-label="Add reference images"
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      {!regenerating ? (
        <label className="mt-3 flex items-center gap-3 text-xs font-semibold text-stone-600">
          Variations
          <input
            type="range"
            min={1}
            max={4}
            step={1}
            value={variations}
            disabled={submitting}
            onChange={(event) => onVariationsChange(Number(event.target.value))}
            className="min-w-0 flex-1 accent-accent disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Edit variations"
          />
          <span className="w-5 text-right tabular-nums text-stone-800">{variations}</span>
        </label>
      ) : null}

      {submitting ? (
        <p className="mt-2 text-[11px] font-medium leading-4 text-cyan-800" role="status" aria-live="polite">
          This edit is processing. The region and controls will unlock when the result is ready.
        </p>
      ) : error || disabledReason ? (
        <p
          className={cn("mt-2 text-[11px] leading-4", error ? "text-red-600" : "text-stone-500")}
          role={error ? "alert" : undefined}
        >
          {error ?? disabledReason}
        </p>
      ) : null}

      <button
        type="button"
        onClick={onGenerate}
        disabled={!canGenerate || submitting}
        className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-bold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
      >
        {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
        {submitting
          ? mode === "enhance"
            ? "Enhancing…"
            : "Inpainting…"
          : regenerating
            ? `Regenerate with ${mode}`
            : mode === "enhance"
              ? "Enhance selection"
              : "Inpaint selection"}
      </button>
    </section>
  );
}
