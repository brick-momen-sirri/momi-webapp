// Prometheus text-format metrics for the web/worker split. The same snapshot
// feeds /metrics and the health watchdog, so scrape data and alert decisions can
// never diverge. Pure and dependency-free so it is trivially unit-testable.

export type DispatcherLeaseStatus = {
  enabled: boolean;
  active: boolean;
  heldByThisProcess: boolean;
  ownerId: string | null;
  heartbeatAt: number | null;
  expiresAt: number | null;
};

export type MediaIndexStatus = {
  dirtyRevision: number;
  builtRevision: number;
  cachedRevision: number;
  cachedItems: number;
};

export type ObservabilitySnapshot = {
  role: string;
  pid: number;
  instance: string | null;
  uptimeSeconds: number;
  nowMs: number;
  queue: {
    queued: number;
    active: number;
    runpodActive: number;
    capacity: number;
    dispatcher: DispatcherLeaseStatus;
  };
  mediaIndex: MediaIndexStatus | null;
  memory: { rssMiB: number; heapUsedMiB: number };
  outputDiskFreeBytes: number | null;
};

export function renderPrometheusMetrics(snapshot: ObservabilitySnapshot): string {
  const baseLabels = `role="${snapshot.role}",pid="${snapshot.pid}"`;
  const lines: string[] = [];
  const gauge = (name: string, help: string, value: number) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name}{${baseLabels}} ${value}`);
  };

  gauge("momi_up", "1 if the process is serving.", 1);
  gauge("momi_uptime_seconds", "Process uptime in seconds.", snapshot.uptimeSeconds);

  gauge("momi_queue_queued", "Jobs waiting in the queued state.", snapshot.queue.queued);
  gauge("momi_queue_active", "Jobs in the sending/running state.", snapshot.queue.active);
  gauge("momi_queue_runpod_active", "In-flight RunPod jobs.", snapshot.queue.runpodActive);
  gauge("momi_queue_capacity", "Global RunPod concurrency cap.", snapshot.queue.capacity);

  gauge("momi_dispatcher_lease_active", "1 if a dispatcher lease is currently held by any process.", snapshot.queue.dispatcher.active ? 1 : 0);
  gauge("momi_dispatcher_lease_held", "1 if this process holds the dispatcher lease.", snapshot.queue.dispatcher.heldByThisProcess ? 1 : 0);
  if (snapshot.queue.dispatcher.expiresAt != null) {
    gauge(
      "momi_dispatcher_lease_expires_in_seconds",
      "Seconds until the dispatcher lease expires (negative once stale).",
      Math.round((snapshot.queue.dispatcher.expiresAt - snapshot.nowMs) / 1000),
    );
  }

  if (snapshot.mediaIndex) {
    gauge("momi_media_index_dirty_revision", "Latest media-index dirty revision.", snapshot.mediaIndex.dirtyRevision);
    gauge("momi_media_index_built_revision", "Latest built/published media-index revision.", snapshot.mediaIndex.builtRevision);
    gauge("momi_media_index_cached_revision", "Media-index revision this process has cached.", snapshot.mediaIndex.cachedRevision);
    gauge("momi_media_index_lag", "Dirty minus cached revision (read staleness).", snapshot.mediaIndex.dirtyRevision - snapshot.mediaIndex.cachedRevision);
    gauge("momi_media_index_items", "Number of items in the media index.", snapshot.mediaIndex.cachedItems);
  }

  gauge("momi_memory_rss_mib", "Resident set size in MiB.", snapshot.memory.rssMiB);
  gauge("momi_memory_heap_used_mib", "Heap used in MiB.", snapshot.memory.heapUsedMiB);
  if (snapshot.outputDiskFreeBytes != null) {
    gauge("momi_output_disk_free_bytes", "Free bytes on the output volume.", snapshot.outputDiskFreeBytes);
  }

  return `${lines.join("\n")}\n`;
}
