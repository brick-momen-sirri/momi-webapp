import os from "node:os";

import type { SqliteJobStore } from "../sqliteJobStore.js";

type DispatcherLeaseCoordinatorOptions = {
  enabled: () => boolean;
  store: () => SqliteJobStore | undefined;
  ttlMs: number;
};

export class DispatcherLeaseCoordinator {
  readonly ownerHost = os.hostname();
  readonly ownerId = `${this.ownerHost}:${process.pid}:${crypto.randomUUID()}`;
  private held = false;
  private takeover = false;

  constructor(private readonly options: DispatcherLeaseCoordinatorOptions) {}

  reset() {
    this.held = false;
    this.takeover = false;
  }

  isHeld() {
    if (!this.options.enabled()) return false;
    const store = this.options.store();
    if (!store) return false;
    const lease = store.readDispatcherLease();
    this.held = lease?.ownerId === this.ownerId && lease.expiresAt > Date.now();
    return this.held;
  }

  tryAcquire() {
    if (!this.options.enabled()) return false;
    const store = this.options.store();
    if (!store) return false;
    const now = Date.now();
    const existing = store.readDispatcherLease();
    const replaceOwnerId =
      existing && existing.ownerHost.toLowerCase() === this.ownerHost.toLowerCase() && !processAppearsAlive(existing.ownerPid)
        ? existing.ownerId
        : undefined;
    const acquired = store.tryAcquireDispatcherLease({
      ...this.lease(now),
      now,
      replaceOwnerId,
    });
    const changedOwner = acquired && !this.held;
    if (changedOwner && existing && existing.ownerId !== this.ownerId) this.takeover = true;
    this.held = acquired;
    if (changedOwner) console.log(`Dispatcher lease acquired by ${this.ownerId}.`);
    return acquired;
  }

  maintain() {
    if (!this.options.enabled()) return false;
    const store = this.options.store();
    if (!store) return false;
    if (this.isHeld()) {
      this.held = store.renewDispatcherLease(this.lease(Date.now()));
      return false;
    }
    return this.tryAcquire();
  }

  release() {
    if (!this.held) return;
    try {
      this.options.store()?.releaseDispatcherLease(this.ownerId);
    } catch (error) {
      console.warn(`Could not release dispatcher lease: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    this.reset();
  }

  shouldNormalizeInterruptedJob(startedAt: string | undefined, timeoutMs: number) {
    if (!this.options.enabled() || !this.takeover) return true;
    const startedAtMs = startedAt ? new Date(startedAt).getTime() : Number.NaN;
    return !Number.isFinite(startedAtMs) || startedAtMs <= Date.now() - timeoutMs;
  }

  snapshot(dispatcherProcess: boolean) {
    const store = this.options.store();
    if (!this.options.enabled() || !store) {
      return { enabled: false, active: dispatcherProcess, heldByThisProcess: dispatcherProcess };
    }
    const lease = store.readDispatcherLease();
    const active = Boolean(lease && lease.expiresAt > Date.now());
    return {
      enabled: true,
      active,
      heldByThisProcess: active && lease?.ownerId === this.ownerId,
      ownerId: lease?.ownerId,
      heartbeatAt: lease?.heartbeatAt,
      expiresAt: lease?.expiresAt,
    };
  }

  private lease(now: number) {
    return {
      ownerId: this.ownerId,
      ownerPid: process.pid,
      ownerHost: this.ownerHost,
      heartbeatAt: now,
      expiresAt: now + this.options.ttlMs,
    };
  }
}

function processAppearsAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}
