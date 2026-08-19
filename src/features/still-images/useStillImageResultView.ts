// What the still image results panel is showing, held across a reload.
//
// The panel is unmounted whenever the section is switched away from, so before this
// every trip to Animation and back reset the list to "All presets, newest first" and
// the layout to cards. Both are the sort of thing an artist sets once for an
// afternoon, not per visit.
//
// A hook rather than state in the component so the read-once and write-on-change pair
// stays in one place, and so the component keeps just the state it genuinely owns for
// the duration of a mount -- which card to scroll back to after leaving the grid.

import { useEffect, useState } from "react";

import { readPersistedStillImageResultView, writePersistedStillImageResultView } from "./stillImagePreferences";

export function useStillImageResultView() {
  const [restored] = useState(readPersistedStillImageResultView);
  const [filters, setFilters] = useState(restored.filters);
  const [layout, setLayout] = useState(restored.layout);

  useEffect(() => {
    writePersistedStillImageResultView({ filters, layout });
  }, [filters, layout]);

  return { filters, setFilters, layout, setLayout };
}
