// One line of text that may not fit its box.
//
// A project card is a narrow column, and a line like "2345 · 9 jobs · 1 member ·
// 122 folders" or a long project name was simply cut off with an ellipsis, so the
// end of it -- often the part you wanted -- could not be read at all. Text that
// fits shows as it is. Text that does not fades at its right edge and, while the
// surrounding `group` (the card) is hovered, slides left once to show the rest,
// then eases back when the pointer leaves. The motion is CSS (`.slide-on-hover` in
// styles.css); this only measures how far there is to go.
//
// Nothing about the box's size may change with hover. The first version wrapped
// the text on hover under reduced motion, which changed the measurement, which
// switched the wrap off again -- a loop that flickered many times a second on any
// machine with Windows animations turned off.
//
// The measurement is written straight onto the element -- a data attribute, two
// custom properties and the title -- rather than into state, and only when it
// changes, so a resize or a new count never costs a re-render or restarts a slide.

import { useLayoutEffect, useRef } from "react";
import { cn } from "../utils/classNames";
import { SLIDE_FADE_PX, slideDurationSeconds } from "../utils/slideDuration";

export function SlideOnHoverText({ text, className }: { text: string; className?: string }) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    let applied = "";
    const measure = () => {
      const hidden = Math.max(0, Math.ceil(inner.scrollWidth - outer.clientWidth));
      // Slide past the hidden part by the width of the fade, so the last word
      // comes to rest clear of it instead of under it.
      const distance = hidden > 0 ? hidden + SLIDE_FADE_PX : 0;
      const next = `${distance}|${text}`;
      if (next === applied) return;
      applied = next;
      outer.dataset.overflowing = distance > 0 ? "true" : "false";
      outer.style.setProperty("--slide-distance", `-${distance}px`);
      outer.style.setProperty("--slide-duration", `${slideDurationSeconds(distance)}s`);
      // The whole line on hover for anyone who would rather read than watch.
      outer.title = distance > 0 ? text : "";
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // Both: the box can narrow with the panel, and the text can widen when a web
    // font finishes loading. A transform changes neither, so the slide never
    // re-triggers this.
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span ref={outerRef} className={cn("slide-on-hover block overflow-hidden whitespace-nowrap", className)}>
      <span ref={innerRef} className="slide-on-hover-text inline-block">
        {text}
      </span>
    </span>
  );
}
