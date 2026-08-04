import crypto from "node:crypto";

export type ExecutionClaim = Readonly<{
  jobId: string;
  token: string;
}>;

/** Process-local execution identity; cross-process authority remains the SQLite lease. */
export class ActiveExecutionRegistry {
  private readonly claims = new Map<string, ExecutionClaim>();

  constructor(private readonly createToken: () => string = () => crypto.randomUUID()) {}

  begin(jobId: string): ExecutionClaim | undefined {
    if (this.claims.has(jobId)) return undefined;
    const claim = Object.freeze({ jobId, token: this.createToken() });
    this.claims.set(jobId, claim);
    return claim;
  }

  has(jobId: string) {
    return this.claims.has(jobId);
  }

  isCurrent(claim: ExecutionClaim) {
    return this.claims.get(claim.jobId)?.token === claim.token;
  }

  finish(claim: ExecutionClaim) {
    if (!this.isCurrent(claim)) return false;
    this.claims.delete(claim.jobId);
    return true;
  }

  jobIds(): ReadonlySet<string> {
    return new Set(this.claims.keys());
  }

  clear() {
    this.claims.clear();
  }
}
