import { useEffect, useRef, useState } from "react";

/**
 * Tracks whether the returned ref has come within `rootMargin` of the viewport.
 *
 * Latches: once true it stays true, because media that has already loaded should
 * not be torn down and refetched when the card scrolls away again.
 *
 * Whether the browser supports IntersectionObserver cannot change during a
 * session, so it is an initial value rather than something to discover in an
 * effect and then set state about. Without support there is no way to know when
 * a card scrolls into view, so media loads immediately.
 */
export function useNearViewport<T extends HTMLElement>(rootMargin = "600px 0px") {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(() => typeof window === "undefined" || !("IntersectionObserver" in window));

  useEffect(() => {
    const node = ref.current;
    // Nothing to observe, or already latched by a previous intersection.
    if (!node || inView) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [inView, rootMargin]);

  return [ref, inView] as const;
}
