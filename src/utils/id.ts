export function createClientId(prefix = "") {
  const uuid = browserRandomUuid();
  const id = uuid ? uuid.replaceAll("-", "") : fallbackRandomId();
  return `${prefix}${id}`;
}

function browserRandomUuid() {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid !== "function") {
    return "";
  }

  try {
    return randomUuid.call(globalThis.crypto);
  } catch {
    return "";
  }
}

function fallbackRandomId() {
  const bytes = new Uint8Array(16);
  const getRandomValues = globalThis.crypto?.getRandomValues;

  if (typeof getRandomValues === "function") {
    try {
      getRandomValues.call(globalThis.crypto, bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
      // Fall back below.
    }
  }

  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`;
}
