// Global test setup: jest-dom matchers, plus jsdom shims for the browser APIs
// this app uses that jsdom does not implement.
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// JobPreview lazy-loads media behind an IntersectionObserver. jsdom has none, so
// without this the component throws on mount. This stub reports every observed
// element as immediately visible, which is the behaviour tests want: media
// loading is not what these tests are about.
class ImmediateIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = "";
  readonly thresholds: ReadonlyArray<number> = [];

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target, intersectionRatio: 1 } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

vi.stubGlobal("IntersectionObserver", ImmediateIntersectionObserver);

// jsdom implements neither of these on HTMLMediaElement, and video results call
// them. Left as no-ops rather than mocks: no test asserts on playback.
Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
  configurable: true,
  value: () => Promise.resolve(),
});
Object.defineProperty(window.HTMLMediaElement.prototype, "pause", {
  configurable: true,
  value: () => {},
});

// Not implemented in jsdom; used by modal and menu positioning.
Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: () => {},
});
