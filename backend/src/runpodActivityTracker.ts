// Tracks in-flight RunPod operations that can spend account credits, so
// balance-delta accounting only attributes a delta to a job when that job was
// provably the only spender between its before/after balance snapshots.
//
// Every entry point that can spend RunPod credits must call
// beginRunpodBillableOperation() and invoke the returned end() when finished
// (queue jobs in jobQueue.ts, prompt helper flows in runpodService.ts,
// klingPromptWorkflowService.ts, and seedancePromptWorkflowService.ts).

export type RunpodActivityBaseline = {
  activeOperations: number;
  operationStartCounter: number;
};

let activeOperations = 0;
let operationStartCounter = 0;

export function beginRunpodBillableOperation(): () => void {
  activeOperations += 1;
  operationStartCounter += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeOperations = Math.max(0, activeOperations - 1);
  };
}

// Capture immediately after beginRunpodBillableOperation() so the baseline
// includes the caller's own operation and nothing that starts later.
export function runpodActivityBaseline(): RunpodActivityBaseline {
  return { activeOperations, operationStartCounter };
}

// True iff the caller's operation was the only active one at baseline time and
// no other billable operation has started since. The start counter never
// decrements, so an operation that starts and finishes inside the window still
// taints it.
export function hasExclusiveRunpodActivityWindow(baseline: RunpodActivityBaseline): boolean {
  return baseline.activeOperations === 1 && operationStartCounter === baseline.operationStartCounter;
}

export function resetRunpodActivityTracking() {
  activeOperations = 0;
  operationStartCounter = 0;
}
