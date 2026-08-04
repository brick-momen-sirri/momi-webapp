import { AlertCircle, CheckCircle2, Info, Loader2, X } from "lucide-react";

export type ToastType = "success" | "error" | "info";
export type ToastItem = { id: number; type: ToastType; message: string };

export function WorkspaceLoadingScreen({
  title,
  message,
  accountName,
}: {
  title: string;
  message: string;
  accountName?: string;
}) {
  return (
    <div className="grain flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-white p-5 text-center shadow-2xl">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
        <p className="mt-4 text-sm font-bold text-ink">{title}</p>
        {accountName ? <p className="mt-1 truncate text-xs font-semibold text-stone-500">{accountName}</p> : null}
        <p className="mx-auto mt-3 max-w-xs text-xs leading-5 text-stone-500">{message}</p>
      </div>
    </div>
  );
}

export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[1100] flex w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 flex-col gap-2">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />
      ))}
    </div>
  );
}

const toastStyles: Record<ToastType, { container: string; icon: typeof CheckCircle2; iconClass: string }> = {
  success: { container: "border-line bg-white text-ink", icon: CheckCircle2, iconClass: "text-accent" },
  error: { container: "border-red-200 bg-red-50 text-red-800", icon: AlertCircle, iconClass: "text-red-600" },
  info: { container: "border-blue-200 bg-blue-50 text-blue-800", icon: Info, iconClass: "text-blue-600" },
};

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const style = toastStyles[toast.type];
  const Icon = style.icon;
  return (
    <div
      role={toast.type === "error" ? "alert" : "status"}
      className={`pointer-events-auto flex items-center gap-3 rounded-lg border px-4 py-3 text-sm font-semibold shadow-2xl ${style.container}`}
    >
      <Icon className={`h-5 w-5 shrink-0 ${style.iconClass}`} />
      <span className="min-w-0 flex-1">{toast.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="flex h-7 w-7 items-center justify-center rounded-md text-current opacity-60 transition hover:opacity-100"
        title="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
