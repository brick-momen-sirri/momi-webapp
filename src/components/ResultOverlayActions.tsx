import type { ReactNode } from "react";

/**
 * The controls that sit on top of a result image.
 *
 * Extracted from JobPreview's fullscreen button so every result surface uses one
 * style rather than each growing its own. Anchored top-right: a result's subject
 * is usually centred or low in the frame, so the top corner is the least
 * destructive place to put chrome, and it matches where the Animation cards
 * already put theirs.
 */
export function ResultOverlayActions({ children }: { children: ReactNode }) {
  return <div className="absolute right-2 top-2 z-20 flex items-center gap-1.5">{children}</div>;
}

const OVERLAY_BUTTON_CLASS =
  "flex h-8 items-center justify-center gap-1.5 rounded-md bg-white/90 px-2 text-ink shadow-card transition hover:bg-white";

export function ResultOverlayButton({
  icon,
  label,
  onClick,
  showLabel = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  showLabel?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${OVERLAY_BUTTON_CLASS} ${showLabel ? "" : "w-8 px-0"}`}
      title={label}
      aria-label={label}
    >
      {icon}
      {showLabel ? <span className="text-xs font-bold">{label}</span> : null}
    </button>
  );
}

export function ResultOverlayLink({
  icon,
  label,
  href,
  showLabel = false,
}: {
  icon: ReactNode;
  label: string;
  href: string;
  showLabel?: boolean;
}) {
  return (
    <a href={href} download className={`${OVERLAY_BUTTON_CLASS} ${showLabel ? "" : "w-8 px-0"}`} title={label} aria-label={label}>
      {icon}
      {showLabel ? <span className="text-xs font-bold">{label}</span> : null}
    </a>
  );
}
