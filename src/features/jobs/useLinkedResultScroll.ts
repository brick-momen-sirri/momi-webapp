import { useEffect, useRef } from "react";

import { resultCardElementId } from "../../utils/resultCard";

export type LinkedResult = { jobId: string; request: number };

/** How long the feed keeps the linked card in view while the page loads around it. */
const FOLLOW_MS = 6000;

/**
 * Keep a linked result's card in view while its feed settles.
 *
 * One scroll is not enough: the link switches project, and the newest page of that
 * project arrives a moment later and renders above an older result, pushing its
 * card out of view. So the card is scrolled to again whenever the visible list
 * changes, for a few seconds, and never again once the artist scrolls or presses a
 * key -- following them past that point would be fighting them.
 */
export function useLinkedResultScroll(link: LinkedResult | undefined, layout: string, visibleJobs: unknown) {
  const followUntil = useRef(0);
  const request = link?.request;
  const jobId = link?.jobId;

  useEffect(() => {
    if (!request) return;
    followUntil.current = Date.now() + FOLLOW_MS;
    const stop = () => {
      followUntil.current = 0;
    };
    const events = ["wheel", "touchstart", "keydown", "mousedown"] as const;
    for (const event of events) window.addEventListener(event, stop, { passive: true });
    return () => {
      for (const event of events) window.removeEventListener(event, stop);
    };
  }, [request]);

  useEffect(() => {
    if (!jobId || layout !== "list" || Date.now() > followUntil.current) return;
    document.getElementById(resultCardElementId(jobId))?.scrollIntoView?.({ block: "start" });
  }, [jobId, request, layout, visibleJobs]);
}
