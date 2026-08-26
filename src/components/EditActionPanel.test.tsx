import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EditActionPanel } from "./EditActionPanel";

function props() {
  return {
    mode: "inpaint" as const,
    prompt: "",
    references: [],
    variations: 2,
    regenerating: false,
    submitting: false,
    canGenerate: false,
    onModeChange: vi.fn(),
    onPromptChange: vi.fn(),
    onReferencesChange: vi.fn(),
    onVariationsChange: vi.fn(),
    onGenerate: vi.fn(),
  };
}

describe("EditActionPanel", () => {
  it("keeps prompt, mode, variations, references and generation in the floating panel", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    render(<EditActionPanel {...callbacks} />);

    await user.type(screen.getByRole("textbox"), "new tree");
    await user.click(screen.getByRole("button", { name: "enhance" }));
    await user.click(screen.getByRole("button", { name: "Inpaint selection" }));

    expect(callbacks.onPromptChange).toHaveBeenLastCalledWith("e");
    expect(callbacks.onModeChange).toHaveBeenCalledWith("enhance");
    expect(callbacks.onGenerate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Edit variations")).toHaveValue("2");
    expect(screen.getByLabelText("Add reference images")).toBeInTheDocument();
  });

  it("removes a reference without disturbing the other references", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const references = [
      { id: "one", name: "one.png", url: "/one.png" },
      { id: "two", name: "two.png", url: "/two.png" },
    ];
    render(<EditActionPanel {...callbacks} references={references} canGenerate />);

    await user.click(screen.getByRole("button", { name: "Remove one.png" }));
    expect(callbacks.onReferencesChange).toHaveBeenCalledWith([references[1]]);
  });

  it("locks every edit control and names the real operation while processing", () => {
    const callbacks = props();
    render(<EditActionPanel {...callbacks} prompt="replace the chair" canGenerate submitting />);

    expect(screen.getByRole("button", { name: "Inpainting…" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "inpaint" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "enhance" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /add/i })).toBeDisabled();
    expect(screen.getByLabelText("Edit variations")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/controls will unlock when the result is ready/i);
  });
});
