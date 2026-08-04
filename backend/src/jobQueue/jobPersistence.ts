import type { SqliteJobStore } from "../sqliteJobStore.js";
import { writeJsonFile } from "../storageService.js";
import type { Job } from "../types.js";

type JobPersistenceOptions = {
  jobs: () => Job[];
  store: () => SqliteJobStore | undefined;
  jsonPath: string;
  debounceMs?: number;
};

// Coalesces whole-store writes for the compatibility path. Row-level SQLite
// mutations stay in jobQueue because they merge API-owned cancellation fields
// into the current in-flight lifecycle object before writing.
export class DebouncedJobPersistence {
  private timer: NodeJS.Timeout | undefined;
  private pending: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } | undefined;

  constructor(private readonly options: JobPersistenceOptions) {}

  request(): Promise<void> {
    if (!this.pending) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.pending = { promise, resolve, reject };
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.runFlush(), this.options.debounceMs ?? 500);
      this.timer.unref?.();
    }
    return this.pending.promise;
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.runFlush();
  }

  private async runFlush() {
    this.timer = undefined;
    const flush = this.pending;
    if (!flush) return;
    this.pending = undefined;
    try {
      const store = this.options.store();
      if (store) store.replaceAll(this.options.jobs());
      else await writeJsonFile(this.options.jsonPath, this.options.jobs());
      flush.resolve();
    } catch (error) {
      flush.reject(error);
    }
  }
}
