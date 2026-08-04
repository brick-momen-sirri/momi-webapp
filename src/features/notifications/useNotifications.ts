import { useEffect, useRef, useState } from "react";

import type { ToastItem, ToastType } from "../../components/AppFeedback";

export function useNotifications() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);
  const timers = useRef(new Set<number>());

  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  function dismissToast(id: number) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function showToast(message: string, type: ToastType = "success") {
    const id = (toastIdRef.current += 1);
    setToasts((current) => [...current, { id, type, message }].slice(-4));
    if (type !== "error") {
      const timer = window.setTimeout(
        () => {
          timers.current.delete(timer);
          dismissToast(id);
        },
        type === "info" ? 3200 : 2600,
      );
      timers.current.add(timer);
    }
  }

  return { toasts, showToast, dismissToast };
}
