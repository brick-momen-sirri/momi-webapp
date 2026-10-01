import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "./copyText";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalSecure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
const originalExec = document.execCommand;

function setContext(secure: boolean, writeText?: (text: string) => Promise<void>) {
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: secure });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: writeText ? { writeText } : undefined });
}

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (originalSecure) Object.defineProperty(window, "isSecureContext", originalSecure);
  else Reflect.deleteProperty(window, "isSecureContext");
  document.execCommand = originalExec;
});

describe("copyText", () => {
  it("uses the Clipboard API where the page is a secure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setContext(true, writeText);
    document.execCommand = vi.fn();
    await expect(copyText("http://momi/?result=job_1")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("http://momi/?result=job_1");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to a selected field over plain http, and leaves nothing behind", async () => {
    setContext(false);
    let copied = "";
    document.execCommand = vi.fn(() => {
      copied = (document.activeElement as HTMLTextAreaElement | null)?.value ?? "";
      return true;
    });
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();

    await expect(copyText("http://10.0.0.5:8190/?result=job_1")).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(copied).toBe("http://10.0.0.5:8190/?result=job_1");
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it("falls back when the Clipboard API refuses, and reports a total failure", async () => {
    setContext(true, vi.fn().mockRejectedValue(new Error("denied")));
    document.execCommand = vi.fn(() => true);
    await expect(copyText("a")).resolves.toBe(true);

    document.execCommand = vi.fn(() => false);
    await expect(copyText("a")).resolves.toBe(false);
    document.execCommand = vi.fn(() => {
      throw new Error("not supported");
    });
    await expect(copyText("a")).resolves.toBe(false);
  });
});
