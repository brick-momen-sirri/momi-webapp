import { useEffect, useRef, useState } from "react";
import { ArrowRight, Wand2 } from "lucide-react";

import { STILL_IMAGE_CATEGORIES, type StillImageCategoryId } from "../features/still-images/stillImageCategories";

/**
 * Send this result into another preset as its input.
 *
 * A menu rather than a plain button because the target preset is the decision:
 * the chain artists actually walk is enhance-then-upscale, and a button that
 * silently used whichever preset the left panel happened to be showing would be
 * wrong about as often as it was right.
 *
 * Follows MoveResultMenu's shape -- open state, outside pointerdown, Escape --
 * so the two menus on a card behave the same way.
 */
export function UseAsInputMenu({
  onSelect,
  disabledReason,
}: {
  onSelect: (categoryId: StillImageCategoryId) => void;
  /** When set, the control is inert and says why. */
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const enabled = !disabledReason;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => enabled && setOpen((value) => !value)}
        disabled={!enabled}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`flex h-8 items-center justify-center gap-1.5 rounded-md px-2 shadow-card transition ${
          open ? "bg-white text-accent" : enabled ? "bg-white/90 text-ink hover:bg-white" : "cursor-not-allowed bg-white/70 text-stone-300"
        }`}
        title={disabledReason ?? "Use this result as the input for another preset"}
        aria-label="Use as input"
      >
        <Wand2 className="h-4 w-4" />
        <span className="text-xs font-bold">Use as input</span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Send this result to a preset"
          className="absolute right-0 top-10 z-30 w-60 rounded-lg border border-line bg-white p-1.5 shadow-panel"
        >
          <p className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-500">Send to</p>
          {STILL_IMAGE_CATEGORIES.map((category) => {
            const Icon = category.icon;
            return (
              <button
                key={category.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onSelect(category.id);
                  setOpen(false);
                }}
                className="group flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition hover:bg-mist"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-stone-50 text-stone-600 group-hover:border-accent group-hover:text-accent">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 text-xs font-bold">{category.label}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-stone-300 group-hover:text-accent" />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
