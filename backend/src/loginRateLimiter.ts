// Throttles failed sign-in attempts on /api/auth/login.
//
// Password verification is scrypt at N=16384, so each guess costs ~100ms of CPU.
// That slows an online attacker but does not bound them, and firing guesses in
// parallel is also a cheap way to starve this box of CPU while renders are
// dispatching. So: count failures in a sliding window, and once a key crosses
// the threshold, refuse further attempts for a lockout period without touching
// scrypt at all.
//
// Every attempt is counted twice, under two keys:
//   ip:<address>    -- stops one host walking a user list
//   id:<identifier> -- stops a distributed guess against one account
// Either key tripping is enough to refuse, and a successful login clears both.
//
// In-memory and per-process, matching alertHistory: with api:N workers the
// effective ceiling is N x maxAttempts. That is accepted deliberately -- the
// goal is to bound guessing, and a shared SQLite counter would put a write on
// the login path for every attempt.

export type LoginRateLimitConfig = {
  maxAttempts: number;
  windowMs: number;
  lockoutMs: number;
};

export type LoginRateLimitVerdict = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type FailureEntry = {
  // Failure timestamps inside the current window, oldest first.
  timestamps: number[];
  lastFailureMs: number;
  // Set when the threshold is crossed. Held explicitly rather than re-derived
  // from `timestamps`, because those age out of the window on their own: with a
  // lockout longer than the window, deriving it would release the lock early.
  lockedUntilMs: number;
};

// Bound on distinct tracked keys, so a spray across many IPs or usernames
// cannot grow this map without limit. When exceeded, the least recently active
// entries are dropped first -- they are the ones closest to expiring anyway.
const MAX_TRACKED_KEYS = 5000;

export function createLoginRateLimiter(config: LoginRateLimitConfig) {
  const failures = new Map<string, FailureEntry>();

  function prune(nowMs: number) {
    for (const [key, entry] of failures) {
      const staleWindow = nowMs - entry.lastFailureMs >= config.windowMs;
      if (staleWindow && nowMs >= entry.lockedUntilMs) failures.delete(key);
    }
    if (failures.size <= MAX_TRACKED_KEYS) return;
    const byAge = [...failures.entries()].sort((left, right) => left[1].lastFailureMs - right[1].lastFailureMs);
    for (const [key] of byAge.slice(0, failures.size - MAX_TRACKED_KEYS)) {
      failures.delete(key);
    }
  }

  function verdictForKey(key: string, nowMs: number): LoginRateLimitVerdict {
    const entry = failures.get(key);
    if (!entry || nowMs >= entry.lockedUntilMs) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.lockedUntilMs - nowMs) / 1000)) };
  }

  return {
    // Checked before any password work happens.
    check(keys: string[], nowMs: number): LoginRateLimitVerdict {
      let worst: LoginRateLimitVerdict = { allowed: true, retryAfterSeconds: 0 };
      for (const key of keys) {
        const verdict = verdictForKey(key, nowMs);
        if (!verdict.allowed && verdict.retryAfterSeconds > worst.retryAfterSeconds) worst = verdict;
      }
      return worst;
    },

    recordFailure(keys: string[], nowMs: number): void {
      for (const key of keys) {
        const entry = failures.get(key) ?? { timestamps: [], lastFailureMs: nowMs, lockedUntilMs: 0 };
        entry.timestamps = entry.timestamps.filter((at) => nowMs - at < config.windowMs);
        entry.timestamps.push(nowMs);
        entry.lastFailureMs = nowMs;
        if (entry.timestamps.length >= config.maxAttempts) {
          entry.lockedUntilMs = nowMs + config.lockoutMs;
          // The lockout replaces the window's tally, so serving it out returns
          // the key to a clean slate rather than one failure from re-locking.
          entry.timestamps = [];
        }
        failures.set(key, entry);
      }
      prune(nowMs);
    },

    // A correct password proves the caller is not the attacker this is aimed at.
    recordSuccess(keys: string[]): void {
      for (const key of keys) failures.delete(key);
    },

    trackedKeyCount(): number {
      return failures.size;
    },
  };
}

export function loginRateLimitKeys(remoteAddress: string | undefined, identifier: string): string[] {
  const keys: string[] = [];
  const address = remoteAddress?.trim();
  if (address) keys.push(`ip:${address.toLowerCase()}`);
  const id = identifier.trim().toLowerCase();
  if (id) keys.push(`id:${id}`);
  return keys;
}
