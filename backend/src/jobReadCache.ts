import type { JobStoreChanges, JobStoreSnapshot } from "./sqliteJobStore.js";
import type { Job } from "./types.js";

export function mergeJobChangesById(current: Job[], changes: JobStoreChanges, inFlightIds: ReadonlySet<string>) {
  const deletedIds = new Set(changes.deletedIds);
  const retained = current.filter((job) => !deletedIds.has(job.id) || inFlightIds.has(job.id));
  const byId = new Map(retained.map((job) => [job.id, job]));
  const inserted: Job[] = [];

  for (const incoming of changes.upserts) {
    const existing = byId.get(incoming.id);
    if (existing) {
      mergeJobObject(existing, incoming, inFlightIds.has(incoming.id));
    } else {
      inserted.push(incoming);
      byId.set(incoming.id, incoming);
    }
  }

  return [...inserted, ...retained];
}

export function mergeJobSnapshotById(current: Job[], snapshot: JobStoreSnapshot, inFlightIds: ReadonlySet<string>) {
  const byId = new Map(current.map((job) => [job.id, job]));
  const snapshotIds = new Set(snapshot.jobs.map((job) => job.id));
  const merged = snapshot.jobs.map((incoming) => {
    const existing = byId.get(incoming.id);
    if (!existing) return incoming;
    mergeJobObject(existing, incoming, inFlightIds.has(incoming.id));
    return existing;
  });

  for (const existing of current) {
    if (inFlightIds.has(existing.id) && !snapshotIds.has(existing.id)) merged.push(existing);
  }
  return merged;
}

function mergeJobObject(target: Job, source: Job, inFlight: boolean) {
  if (!inFlight) {
    for (const key of Object.keys(target) as Array<keyof Job>) {
      if (!(key in source)) delete target[key];
    }
    Object.assign(target, source);
    return;
  }

  // A dispatcher mutates lifecycle fields across long awaits. During that
  // window only merge fields owned by API writers; replacing or broadly
  // assigning the stored row could erase an unpersisted completion.
  copyJobField(target, source, "title");
  copyJobField(target, source, "folderId");
  copyJobField(target, source, "folderName");
  copyJobField(target, source, "cancelRequested");
  if (source.workflowOptions?.save) {
    target.workflowOptions = {
      ...(target.workflowOptions ?? {}),
      save: { ...source.workflowOptions.save },
    };
  }
}

function copyJobField<K extends keyof Job>(target: Job, source: Job, key: K) {
  if (key in source) {
    target[key] = source[key];
  } else {
    delete target[key];
  }
}
