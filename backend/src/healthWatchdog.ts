// Dispatch/queue health watchdog for the web/worker split. Evaluates a small set
// of rules on a timer and emits transition-based alerts (one event when a rule
// starts firing, one when it resolves — never per-tick spam). The evaluator is a
// pure function that takes an explicit `now`, so it is deterministic and has no
// hidden clock; the runner is a thin timer around it.

import type { ObservabilitySnapshot } from "./observabilityMetrics.js";
import { recordAlert } from "./alertHistory.js";

export type AlertSeverity = "warning" | "critical";
export type AlertRule = "queue_stall" | "dispatch_outage" | "memory_high" | "disk_low" | "backup_failed" | "backup_upload_failed";
export type AlertPhase = "firing" | "resolved";

export type AlertEvent = {
  rule: AlertRule;
  phase: AlertPhase;
  severity: AlertSeverity;
  detail: string;
  role: string;
  pid: number;
  atMs: number;
};

export type WatchdogThresholds = {
  // Consecutive evaluations with a non-draining backlog (queued > 0 while RunPod
  // capacity is free) before queue_stall fires.
  queueStallEvals: number;
  diskFreeMinBytes: number;
  memoryHighMiB: number;
};

export type WatchdogFlags = {
  // Dispatcher/monolith own dispatch, so only they can judge a dispatch stall.
  evaluatesQueueStall: boolean;
  // A designated API worker watches for a dead/expired dispatcher lease (the
  // dispatcher cannot alert on its own death).
  evaluatesOutage: boolean;
};

export type WatchdogState = {
  stallCount: number;
  lastQueued: number | null;
  active: Record<string, { since: number; severity: AlertSeverity }>;
};

export function initialWatchdogState(): WatchdogState {
  return { stallCount: 0, lastQueued: null, active: {} };
}

type FiringCondition = { severity: AlertSeverity; detail: string };

export function evaluateAlerts(
  snapshot: ObservabilitySnapshot,
  state: WatchdogState,
  thresholds: WatchdogThresholds,
  flags: WatchdogFlags,
  nowMs: number,
): { events: AlertEvent[]; state: WatchdogState } {
  const firing: Partial<Record<AlertRule, FiringCondition>> = {};
  const queue = snapshot.queue;
  const capacityFree = queue.runpodActive < queue.capacity;

  // queue_stall: capacity is available but the backlog is not shrinking.
  let stallCount = state.stallCount;
  if (flags.evaluatesQueueStall && queue.queued > 0 && capacityFree) {
    if (state.lastQueued != null && queue.queued < state.lastQueued) {
      stallCount = 0; // draining — real progress this tick
    } else {
      stallCount += 1;
    }
  } else {
    stallCount = 0;
  }
  if (flags.evaluatesQueueStall && stallCount >= thresholds.queueStallEvals) {
    firing.queue_stall = {
      severity: "critical",
      detail: `queued=${queue.queued} not draining over ${stallCount} checks with ${queue.capacity - queue.runpodActive} free RunPod slot(s)`,
    };
  }

  // dispatch_outage: a designated API worker sees queued work but no live lease.
  if (flags.evaluatesOutage) {
    const lease = queue.dispatcher;
    const leaseDead = !lease.active || lease.expiresAt == null || nowMs > lease.expiresAt;
    if (queue.queued > 0 && leaseDead) {
      firing.dispatch_outage = {
        severity: "critical",
        detail: `no live dispatcher lease (active=${lease.active}, expiresAt=${lease.expiresAt}) while queued=${queue.queued}`,
      };
    }
  }

  // memory_high: warn before pm2's max_memory_restart force-kills the process.
  if (snapshot.memory.rssMiB > thresholds.memoryHighMiB) {
    firing.memory_high = {
      severity: "warning",
      detail: `rss=${snapshot.memory.rssMiB}MiB over ${thresholds.memoryHighMiB}MiB`,
    };
  }

  // disk_low: the output volume is running out of room for results.
  if (snapshot.outputDiskFreeBytes != null && snapshot.outputDiskFreeBytes < thresholds.diskFreeMinBytes) {
    firing.disk_low = {
      severity: "warning",
      detail: `output disk free ${Math.round(snapshot.outputDiskFreeBytes / 1048576)}MiB under ${Math.round(thresholds.diskFreeMinBytes / 1048576)}MiB`,
    };
  }

  const events: AlertEvent[] = [];
  const active = { ...state.active };

  for (const rule of Object.keys(firing) as AlertRule[]) {
    if (!active[rule]) {
      const condition = firing[rule]!;
      events.push({ rule, phase: "firing", severity: condition.severity, detail: condition.detail, role: snapshot.role, pid: snapshot.pid, atMs: nowMs });
      active[rule] = { since: nowMs, severity: condition.severity };
    }
  }
  for (const rule of Object.keys(active) as AlertRule[]) {
    if (!firing[rule]) {
      const prior = active[rule]!;
      events.push({ rule, phase: "resolved", severity: prior.severity, detail: `recovered after ${Math.round((nowMs - prior.since) / 1000)}s`, role: snapshot.role, pid: snapshot.pid, atMs: nowMs });
      delete active[rule];
    }
  }

  return { events, state: { stallCount, lastQueued: queue.queued, active } };
}

export type WebhookFormat = "json" | "slack";

export function buildWebhookPayload(event: AlertEvent, format: WebhookFormat): Record<string, unknown> {
  if (format === "slack") {
    const icon = event.phase === "firing" ? (event.severity === "critical" ? "🔴" : "🟠") : "✅";
    return { text: `${icon} [${event.severity}] ${event.rule} ${event.phase} on ${event.role} (pid ${event.pid}): ${event.detail}` };
  }
  return {
    rule: event.rule,
    phase: event.phase,
    severity: event.severity,
    role: event.role,
    pid: event.pid,
    detail: event.detail,
    atMs: event.atMs,
  };
}

async function postWebhook(url: string, format: WebhookFormat, event: AlertEvent): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildWebhookPayload(event, format)),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.warn("[alert] webhook post failed:", error instanceof Error ? error.message : String(error));
  }
}

export function emitAlert(event: AlertEvent, opts: { webhookUrl?: string; webhookFormat?: WebhookFormat }): void {
  recordAlert(event);
  const line = { rule: event.rule, phase: event.phase, severity: event.severity, role: event.role, pid: event.pid, detail: event.detail };
  if (event.phase === "firing") {
    console.warn("[alert]", line);
  } else {
    console.info("[alert]", line);
  }
  if (opts.webhookUrl) {
    void postWebhook(opts.webhookUrl, opts.webhookFormat ?? "json", event);
  }
}

export type HealthWatchdog = { start: () => void; stop: () => void; tickOnce: () => Promise<void> };

export function createHealthWatchdog(opts: {
  getSnapshot: () => Promise<ObservabilitySnapshot>;
  thresholds: WatchdogThresholds;
  flags: WatchdogFlags;
  intervalMs: number;
  webhookUrl?: string;
  webhookFormat?: WebhookFormat;
  now?: () => number;
  emit?: (event: AlertEvent) => void;
}): HealthWatchdog {
  let state = initialWatchdogState();
  let timer: ReturnType<typeof setInterval> | undefined;
  const now = opts.now ?? (() => Date.now());
  const emit = opts.emit ?? ((event: AlertEvent) => emitAlert(event, { webhookUrl: opts.webhookUrl, webhookFormat: opts.webhookFormat }));

  async function tickOnce(): Promise<void> {
    let snapshot: ObservabilitySnapshot;
    try {
      snapshot = await opts.getSnapshot();
    } catch (error) {
      console.warn("[alert] watchdog snapshot failed:", error instanceof Error ? error.message : String(error));
      return;
    }
    const result = evaluateAlerts(snapshot, state, opts.thresholds, opts.flags, now());
    state = result.state;
    for (const event of result.events) emit(event);
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tickOnce(), opts.intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    tickOnce,
  };
}
