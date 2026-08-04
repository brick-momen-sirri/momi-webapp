import { useState } from "react";

/**
 * Runs `reset` during render when `key` changes, instead of in an effect.
 *
 * This is React's documented "adjusting state when a prop changes" pattern, and
 * it exists here because the same shape appeared in a dozen components: an effect
 * whose only job was to reset or normalise some state whenever an input changed.
 *
 * Why not an effect. An effect runs after the browser has already painted, so the
 * user sees one frame rendered with the stale value before the reset lands, and
 * React does a second render pass to correct it. Doing it during render means
 * React discards the in-progress render and restarts with the new state before
 * anything is committed -- no wasted paint, no intermediate frame, and no
 * cascading-render warning from react-hooks/set-state-in-effect.
 *
 * The setState-during-render this performs is legal precisely because it is
 * conditional on a change and updates the tracking state in the same pass, so it
 * cannot loop.
 *
 * Use it only for resetting state you own from an input you do not. It is not for
 * synchronising with anything external (network, subscriptions, the DOM) -- those
 * are what effects are actually for.
 */
export function useResetWhenChanged(key: unknown, reset: () => void) {
  const [previousKey, setPreviousKey] = useState(key);

  if (!Object.is(previousKey, key)) {
    setPreviousKey(key);
    reset();
  }
}
