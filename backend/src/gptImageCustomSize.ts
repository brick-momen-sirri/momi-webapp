// Turning a source crop's dimensions into a size GPT Image will accept.
//
// Nano Banana takes `aspect_ratio: "auto"` and gives back the source's framing.
// GPT Image has no aspect input at all: it takes a `size` from a fixed enum, or
// "Custom" with explicit dimensions. The enum's aspects are 1:1, 2:3, 3:2, 16:9
// and 9:16, so anything else comes back in the wrong shape -- and because the
// graph scales the result to the source's exact size before compositing, a wrong
// shape arrives *distorted* rather than cropped. Custom is the only option that
// never does that, so the graph always uses it and this works out the numbers.
//
// The node validates Custom hard, and rejects the whole prompt rather than
// clamping, so every rule has to be satisfied before the job is sent:
//
//   - both edges a multiple of 16
//   - both edges between 1024 and 3840
//   - aspect ratio no wider than 3:1
//   - total pixels no more than 8,294,400
//
// The per-edge minimum is the surprising one, and it is enforced by ComfyUI's
// schema validation before the node's own code runs -- so it fails the whole
// prompt, not the render. A small painted region cannot be sent at its own
// size: it is scaled up to at least 1024 on both edges, which is why a tiny
// touch-up costs what a large one does.
//
// It also dominates the provider's own 655,360 pixel floor, which is why that
// floor is not tracked here: the smallest shape this can return is 1024x1024,
// or 1,048,576 pixels, already above it.

/** Both edges must be a multiple of this, or the node refuses the prompt. */
const STEP = 16;
/** The shortest edge the node accepts. Schema-enforced, so it fails validation. */
const MIN_EDGE = 1024;
/** The longest edge the node accepts. */
const MAX_EDGE = 3840;
/** The widest ratio the node accepts, long edge over short. */
const MAX_ASPECT = 3;
const MAX_PIXELS = 8_294_400;

/**
 * Held back from the pixel ceiling so rounding to a multiple of 16 cannot cross
 * it. Rounding moves an edge by at most 8px, far less than this allows for.
 */
const MARGIN = 1.02;

export type GptImageCustomSize = { width: number; height: number };

/**
 * The size to ask GPT Image for, given the crop being edited.
 *
 * Preserves the source aspect wherever the node's rules allow it, because the
 * result is scaled back to the source and pasted through the mask -- any aspect
 * we fail to preserve here is distortion inside the edited region. Aspect is
 * only sacrificed past 3:1, which the node forbids outright.
 *
 * Total defensiveness about the input: this runs on crop dimensions that came
 * off the wire, and a zero or a NaN reaching the node would fail the job at the
 * provider rather than here.
 */
export function gptImageCustomSize(sourceWidth: number, sourceHeight: number): GptImageCustomSize {
  let width = usableEdge(sourceWidth);
  let height = usableEdge(sourceHeight);

  // Past 3:1 the node refuses, so the long edge comes in to the limit. This is
  // the one case where the source framing cannot be kept.
  if (width / height > MAX_ASPECT) width = height * MAX_ASPECT;
  if (height / width > MAX_ASPECT) height = width * MAX_ASPECT;

  // Up to the per-edge minimum first, scaling as one so the aspect just fixed
  // above survives. This is what a small painted region runs into.
  const shortest = Math.min(width, height);
  if (shortest < MIN_EDGE) {
    const grow = MIN_EDGE / shortest;
    width *= grow;
    height *= grow;
  }

  // Then down, if either ceiling is breached. Neither can push an edge back
  // under the minimum: at 3:1 the widest legal shape is 3072x1024, inside both.
  const longest = Math.max(width, height);
  if (longest > MAX_EDGE) {
    const shrink = MAX_EDGE / longest;
    width *= shrink;
    height *= shrink;
  }
  const pixels = width * height;
  if (pixels > MAX_PIXELS / MARGIN) {
    const shrink = Math.sqrt(MAX_PIXELS / MARGIN / pixels);
    width *= shrink;
    height *= shrink;
  }

  // Up to the next multiple of 16 rather than the nearest, so a value sitting
  // exactly on the minimum cannot be rounded back under it.
  width = ceil16(width);
  height = ceil16(height);

  // Rounding is the last thing to move the numbers, so the rules are checked
  // against what will actually be sent rather than against the ideal. MARGIN
  // makes this a no-op in every case tested; it stays because a silent failure
  // here is a job rejected at the provider, after the user has waited.
  return repair(width, height);
}

/** A positive, finite edge to start from. */
function usableEdge(value: number) {
  return Number.isFinite(value) && value > 0 ? value : MIN_EDGE;
}

/** Next multiple of 16 at or above the value, never below the minimum edge. */
function ceil16(value: number) {
  return Math.max(MIN_EDGE, Math.ceil(value / STEP) * STEP);
}

/**
 * Step a rounded pair back inside the rules.
 *
 * Works in whole 16px steps on the edge that is wrong, so whatever it returns is
 * still legal on the multiple-of-16 rule that everything else here is built to
 * satisfy. Bounded rather than `while (true)`: a rule that cannot be satisfied
 * should give back the closest it got, not hang the request.
 */
function repair(width: number, height: number): GptImageCustomSize {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const longest = Math.max(width, height);
    const shortest = Math.min(width, height);
    const pixels = width * height;

    if (shortest < MIN_EDGE) {
      if (width === shortest) width += STEP;
      else height += STEP;
      continue;
    }
    if (longest > MAX_EDGE) {
      if (width === longest) width -= STEP;
      else height -= STEP;
      continue;
    }
    if (longest / shortest > MAX_ASPECT) {
      if (width === shortest) width += STEP;
      else height += STEP;
      continue;
    }
    if (pixels > MAX_PIXELS) {
      if (width === longest) width -= STEP;
      else height -= STEP;
      continue;
    }
    break;
  }
  return { width, height };
}
