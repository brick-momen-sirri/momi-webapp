/** Width of SlideOnHoverText's faded right edge; keep in step with `.slide-on-hover` in styles.css. */
export const SLIDE_FADE_PX = 20;

/**
 * Seconds for SlideOnHoverText's one slide to the end of its line, at a readable
 * ~45 px/s: a short overflow still takes a moment rather than jumping, and a very
 * long one is capped so the end of it arrives before anyone gives up.
 */
export function slideDurationSeconds(distancePx: number) {
  return Math.round(Math.min(4, Math.max(0.8, distancePx / 45)) * 10) / 10;
}
