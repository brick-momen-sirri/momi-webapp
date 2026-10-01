import { useEffect, useState } from "react";

/** The current time, refreshed every `intervalMs` while `enabled`. */
export function useNow(intervalMs: number, enabled = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}
