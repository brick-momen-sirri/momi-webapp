import { useCallback, useEffect, useRef, useState } from "react";

import { fetchBackendCreditDashboard, type BackendCreditDashboard } from "../../services/backendApi";
import { dashboardRangeParams, type TimePreset } from "./creditUsageDashboardUtils";

export function useCreditDashboard(open: boolean, range: TimePreset, customFrom: string, customTo: string) {
  const [dashboard, setDashboard] = useState<BackendCreditDashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const loadDashboard = useCallback(async () => {
    const currentRequestId = (requestId.current += 1);
    setLoading(true);
    setError("");
    try {
      const nextDashboard = await fetchBackendCreditDashboard(dashboardRangeParams(range, customFrom, customTo));
      if (currentRequestId === requestId.current) setDashboard(nextDashboard);
    } catch (loadError) {
      if (currentRequestId === requestId.current) {
        setError(loadError instanceof Error ? loadError.message : "Could not load credit usage.");
      }
    } finally {
      if (currentRequestId === requestId.current) setLoading(false);
    }
  }, [customFrom, customTo, range]);

  useEffect(() => {
    if (!open) {
      requestId.current += 1;
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the loading state is intrinsic to starting this request
    void loadDashboard();
    return () => {
      // A slow response for a previous range or a closed modal must not replace
      // the current dashboard or leave its loading/error state behind.
      requestId.current += 1;
    };
  }, [loadDashboard, open]);

  return { dashboard, loading, error, reload: loadDashboard };
}
