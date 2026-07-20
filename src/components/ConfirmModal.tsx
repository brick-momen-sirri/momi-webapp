import { useEffect, useRef, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";

export type ConfirmModalProps = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
      if (event.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, onConfirm]);

  function handleOverlayMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      onCancel();
    }
  }

  const confirmClasses = tone === "danger"
    ? "bg-red-600 text-white hover:bg-red-700 focus:ring-red-300"
    : "bg-accent text-white hover:bg-accent/90 focus:ring-accent/30";

  return createPortal(
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-stone-950/45 p-3 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      onMouseDown={handleOverlayMouseDown}
    >
      <div className="w-full max-w-md rounded-lg border border-line bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            {tone === "danger" ? <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" /> : null}
            <h2 id="confirm-modal-title" className="text-sm font-bold text-ink">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-stone-500 transition hover:bg-stone-100"
            title="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="px-4 py-4 text-sm leading-6 text-stone-600">{message}</p>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-line px-3 py-2 text-sm font-semibold text-stone-700 transition hover:bg-stone-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={onConfirm}
            className={`rounded-md px-3 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 ${confirmClasses}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
