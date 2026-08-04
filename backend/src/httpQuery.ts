// Query-string and pagination parsing shared across routes.

export function parsePaginationNumber(value: unknown, fallback: number, max: number) {
  const parsed = Number(getQueryValue(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(0, Math.floor(parsed)), max);
}

export function parseOptionalNumber(value: unknown) {
  const raw = getQueryValue(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function currentMonthRange() {
  const now = new Date();
  const startAt = new Date(now.getFullYear(), now.getMonth(), 1);
  const endAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const month = `${startAt.getFullYear()}-${String(startAt.getMonth() + 1).padStart(2, "0")}`;
  return { startAt, endAt, month };
}

export function getQueryValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function parseBooleanQuery(value: unknown) {
  return typeof value === "string" && ["1", "true", "yes"].includes(value.trim().toLowerCase());
}
