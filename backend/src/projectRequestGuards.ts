// Guards for project mutation requests: has the caller actually asked to
// rename or re-code the project, as opposed to sending its current values back?

import type { Project } from "./types.js";

export function projectRenameRequested(body: unknown, project: Project) {
  if (!body || typeof body !== "object") return false;
  const input = body as Record<string, unknown>;
  const requestedName = typeof input.name === "string" ? input.name.trim() : undefined;
  const requestedClient = typeof input.client === "string" ? input.client.trim() : undefined;
  return Boolean(
    (requestedName && requestedName !== project.name) || (requestedClient && requestedClient !== (project.client ?? "")),
  );
}

export function projectCodeChangeRequested(body: unknown, project: Project) {
  if (!body || typeof body !== "object") return false;
  const input = body as Record<string, unknown>;
  const requestedCode =
    typeof input.code === "string" ? input.code.trim() : typeof input.shortName === "string" ? input.shortName.trim() : undefined;
  return Boolean(requestedCode && requestedCode !== (project.code ?? project.shortName));
}
