export type BackendProcessRole = "monolith" | "dispatcher" | "api";

export function parseBackendProcessRole(value: string | undefined): BackendProcessRole {
  const role = (value ?? "").trim().toLowerCase() || "monolith";
  if (role === "monolith" || role === "dispatcher" || role === "api") {
    return role;
  }
  throw new Error(`Invalid ROLE "${value}". Expected monolith, dispatcher, or api.`);
}

export const backendProcessRole = parseBackendProcessRole(process.env.ROLE);

// The monolith owns both HTTP and dispatcher responsibilities, preserving the
// current single-process behavior until the topology flag is deliberately
// flipped. API-only workers must never perform dispatcher-owned work.
export function isDispatcher() {
  return backendProcessRole !== "api";
}
