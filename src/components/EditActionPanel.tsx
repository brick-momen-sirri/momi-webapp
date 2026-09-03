import { ClipboardPaste, ImagePlus, LoaderCircle, Sparkles, SlidersHorizontal, WandSparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  browserClipboardImageFiles,
  backendClipboardImageFiles,
  clipboardImageFiles,
  dedupeFiles,
  isEditablePasteTarget,
  isImageFile,
  noImageMessage,
} from "../features/still-images/clipboardImages";
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
  /**
   * General Enhancement's own controls, built by the settings panel from the
   * shared preset table. Passed in rather than assembled here so this panel does
   * not need to know what a preset is, and so the ranges and gating stay in the
   * one place that already defines them.
   */
  enhanceControls?: ReactNode;
  /**
   * The preset's own inpaint-time settings -- engine choice, its resolution or
   * quality control, and the region/pre-blend toggles -- built by the settings
   * panel the same way enhanceControls is, so this panel does not need to know
   * what a preset is either.
   */
  inpaintControls?: ReactNode;
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
  enhanceControls,
  inpaintControls,
  onModeChange,
  onPromptChange,
  onReferencesChange,
  onVariationsChange,
  onGenerate,
}: EditActionPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [referenceNotice, setReferenceNotice] = useState<string | undefined>(undefined);
  // Enhance is a different job with a different graph. It takes no reference
  // conditioning and needs no instruction, so the panel stops offering either
  // rather than leaving fields that quietly do nothing.
  const referencesSupported = mode === "inpaint";
  const promptRequired = mode === "inpaint";

  // Read through a ref by the window paste listener, which is registered once
  // and would otherwise close over the first render's references.
  const stateRef = useRef({ references, referencesSupported, submitting });
  useEffect(() => {
    stateRef.current = { references, referencesSupported, submitting };
  }, [references, referencesSupported, submitting]);

  /**
   * Take whatever images were handed over.
   *
   * Reports a refusal it can explain -- a full strip -- separately from simply
   * finding nothing usable, because only the caller knows whether the artist
   * dropped a file or pasted, and so only the caller can word that one.
   */
  const addFiles = useCallback(
    (files: File[]): { added: number; problem?: string } => {
      const { references: current, referencesSupported: allowed, submitting: busy } = stateRef.current;
      if (!allowed || busy) return { added: 0 };
      const room = Math.max(0, MAX_REFERENCES - current.length);
      if (!room) return { added: 0, problem: `References are full (${MAX_REFERENCES}). Remove one first.` };
      const additions = files
        .filter(isImageFile)
        .slice(0, room)
        .map((file) => ({ id: createClientId("editref_"), name: file.name, url: URL.createObjectURL(file) }));
      if (additions.length) onReferencesChange([...current, ...additions]);
      return { added: additions.length };
    },
    [onReferencesChange],
  );

  /** One place that decides what the strip says after an attempt to add. */
  function reportAdd(result: { added: number; problem?: string }, whenNothingUsable: string) {
    setReferenceNotice(result.problem ?? (result.added ? undefined : whenNothingUsable));
    return result.added;
  }

  /**
   * Paste anywhere in the open editor, not just onto the strip.
   *
   * A copy from Photoshop or a browser is a system-wide gesture; asking the
   * artist to click a 60px strip first would be the only place in the app that
   * demanded it. Typing is left alone -- a paste into the prompt is a paste into
   * the prompt.
   */
  useEffect(() => {
    async function onPaste(event: ClipboardEvent) {
      if (!stateRef.current.referencesSupported || stateRef.current.submitting) return;
      if (isEditablePasteTarget(event.target) || !event.clipboardData) return;
      event.preventDefault();
      setReferenceNotice("Pasting image…");
      const result = await clipboardImageFiles(event.clipboardData);
      reportAdd(addFiles(dedupeFiles(result.files)), noImageMessage(result.details));
    }

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles]);

  // The strip's own button, for the times the OS will not give the page a paste
  // event -- a native PNG stream with no browser representation, most often.
  async function pasteFromSystemClipboard() {
    setReferenceNotice("Pasting image…");
    const browser = await browserClipboardImageFiles();
    const fromBrowser = addFiles(dedupeFiles(browser.files));
    if (fromBrowser.added || fromBrowser.problem) return void reportAdd(fromBrowser, "");
    // Nothing the browser could see. The native stream is the backend's to read.
    const backend = await backendClipboardImageFiles();
    reportAdd(addFiles(dedupeFiles(backend.files)), noImageMessage([...browser.details, ...backend.details]));
  }

  function handleDrop(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    if (!referencesSupported || submitting) return;
    const dropped = Array.from(event.dataTransfer.files ?? []);
    if (dropped.length) {
      reportAdd(addFiles(dropped), "That file is not an image the editor can read.");
      return;
    }
    // A drag from a browser carries no File, only markup or a URL to decode.
    void clipboardImageFiles(event.dataTransfer).then((result) => {
      reportAdd(addFiles(dedupeFiles(result.files)), noImageMessage(result.details));
    });
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
        {promptRequired ? null : <span className="ml-1 font-medium text-stone-400">optional</span>}
        <textarea
          value={prompt}
          disabled={submitting}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder={
            promptRequired
              ? "Describe what should replace the selected area…"
              : "Leave empty to let the enhancer read the image itself…"
          }
          rows={promptRequired ? 3 : 2}
          className="mt-1.5 w-full resize-none rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm leading-5 outline-none transition placeholder:text-stone-400 focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:bg-stone-50 disabled:text-stone-500"
        />
      </label>

      {enhanceControls && !promptRequired ? (
        <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-2.5">
          <p className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-stone-400">
            <SlidersHorizontal className="h-3 w-3" />
            Enhancement
          </p>
          <div className="space-y-2.5">{enhanceControls}</div>
        </div>
      ) : null}

      {inpaintControls && promptRequired ? (
        <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-2.5">
          <p className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-stone-400">
            <SlidersHorizontal className="h-3 w-3" />
            Model &amp; settings
          </p>
          <div className="space-y-2.5">{inpaintControls}</div>
        </div>
      ) : null}

      {referencesSupported ? (
        <>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs font-semibold text-stone-600">References</span>
            <span className="text-[10px] text-stone-400">
              {references.length}/{MAX_REFERENCES}
            </span>
            <button
              type="button"
              onClick={() => void pasteFromSystemClipboard()}
              disabled={submitting || references.length >= MAX_REFERENCES}
              title="Paste an image from the clipboard (Ctrl/Cmd+V anywhere in the editor)"
              className="ml-auto flex h-6 items-center gap-1 rounded border border-stone-300 bg-white px-1.5 text-[10px] font-bold text-stone-600 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ClipboardPaste className="h-3 w-3" />
              Paste
            </button>
          </div>

          <div
            onDragOver={(event) => {
              if (submitting) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDragging(true);
            }}
            onDragLeave={(event) => {
              // Only when the pointer has actually left the strip, not merely
              // crossed onto a thumbnail inside it.
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={handleDrop}
            data-testid="edit-references-strip"
            data-dragging={dragging || undefined}
            className={cn(
              "mt-1.5 flex min-h-14 gap-2 overflow-x-auto rounded-lg border p-2 transition",
              dragging ? "border-accent bg-cyan-50 ring-2 ring-accent/30" : "border-stone-200 bg-stone-50",
            )}
          >
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
                disabled={submitting}
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
                addFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
          </div>

          <p className={cn("mt-1 text-[10px] leading-4", referenceNotice ? "text-amber-700" : "text-stone-400")}>
            {referenceNotice ?? "Drop an image here, or press Ctrl/Cmd+V to paste one."}
          </p>
        </>
      ) : null}

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
