// A small in-memory ring buffer of recent alert events, so an operator opening
// the ops dashboard (or hitting /api/alerts/recent) can see what fired in the
// last while, not only alerts they happened to be watching pm2 logs for in
// real time. Per-process by design (matches how alerts are raised: the
// dispatcher judges queue_stall/backup_*, a designated API worker judges
// dispatch_outage) -- there is no cross-process aggregation here, by choice,
// to keep this dependency-free and safe to call from a hot alert path.

export type RecordedAlert = {
  rule: string;
  phase: string;
  severity: string;
  detail: string;
  role: string;
  pid: number;
  atMs: number;
};

const MAX_HISTORY = 200;
let history: RecordedAlert[] = [];

export function recordAlert(event: RecordedAlert): void {
  history.push(event);
  if (history.length > MAX_HISTORY) {
    history = history.slice(history.length - MAX_HISTORY);
  }
}

// Newest first -- that's what a dashboard/log view wants.
export function getRecentAlerts(limit = MAX_HISTORY): RecordedAlert[] {
  const bounded = Math.max(0, Math.min(limit, history.length));
  const result = new Array<RecordedAlert>(bounded);
  for (let i = 0; i < bounded; i += 1) {
    result[i] = history[history.length - 1 - i];
  }
  return result;
}

// Test-only: production code has no legitimate reason to wipe history.
export function _resetAlertHistoryForTests(): void {
  history = [];
}
