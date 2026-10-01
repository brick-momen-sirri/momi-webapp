/**
 * Put text on the clipboard, returning whether it got there.
 *
 * The Clipboard API exists only in a secure context, and Momi is opened over plain
 * http on the studio network, where `navigator.clipboard` is undefined. So the API
 * is tried where it exists and the older selection-and-copy route otherwise; that
 * one still works over http in current browsers. A false return means neither
 * did, and the caller should show the text for copying by hand.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied permission, or an unfocused document: try the fallback.
    }
  }

  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  // Off-screen rather than hidden: a display:none field cannot be selected.
  field.style.position = "fixed";
  field.style.top = "-1000px";
  field.style.opacity = "0";
  document.body.appendChild(field);
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  try {
    // Focused first: "copy" acts on the focused selection, and select() alone does
    // not move focus in every browser.
    field.focus();
    field.select();
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    previousFocus?.focus();
  }
}
