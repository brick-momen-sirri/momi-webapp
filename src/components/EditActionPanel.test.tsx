import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  describe("references", () => {
    function imageFile(name = "reference.png") {
      return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
    }

    function dataTransfer(files: File[]): DataTransfer {
      return { files, items: [], types: files.length ? ["Files"] : [] } as unknown as DataTransfer;
    }

    it("highlights the strip while an image is dragged over it, and drops it in", async () => {
      const callbacks = props();
      render(<EditActionPanel {...callbacks} />);
      const strip = screen.getByTestId("edit-references-strip");

      fireEvent.dragOver(strip, { dataTransfer: dataTransfer([]) });
      expect(strip).toHaveAttribute("data-dragging", "true");

      fireEvent.drop(strip, { dataTransfer: dataTransfer([imageFile()]) });
      expect(strip).not.toHaveAttribute("data-dragging");
      await waitFor(() => expect(callbacks.onReferencesChange).toHaveBeenCalled());
      expect(callbacks.onReferencesChange.mock.calls.at(-1)?.[0]).toHaveLength(1);
    });

    it("refuses a dropped file that is not an image, and says so", async () => {
      const callbacks = props();
      render(<EditActionPanel {...callbacks} />);
      const strip = screen.getByTestId("edit-references-strip");

      fireEvent.drop(strip, { dataTransfer: dataTransfer([new File(["x"], "notes.txt", { type: "text/plain" })]) });
      expect(callbacks.onReferencesChange).not.toHaveBeenCalled();
      expect(await screen.findByText(/not an image the editor can read/i)).toBeInTheDocument();
    });

    it("takes a paste from anywhere in the editor, but leaves a paste into the prompt alone", async () => {
      const callbacks = props();
      render(<EditActionPanel {...callbacks} />);

      const paste = new Event("paste", { bubbles: true }) as Event & { clipboardData: DataTransfer };
      Object.defineProperty(paste, "clipboardData", { value: dataTransfer([imageFile("pasted.png")]) });
      window.dispatchEvent(paste);
      await waitFor(() => expect(callbacks.onReferencesChange).toHaveBeenCalled());

      // A paste while typing is a paste into the textarea, not a new reference.
      callbacks.onReferencesChange.mockClear();
      const typed = new Event("paste", { bubbles: true }) as Event & { clipboardData: DataTransfer };
      Object.defineProperty(typed, "clipboardData", { value: dataTransfer([imageFile("typed.png")]) });
      screen.getByRole("textbox").dispatchEvent(typed);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(callbacks.onReferencesChange).not.toHaveBeenCalled();
    });

    it("stops accepting images once the strip is full", async () => {
      const full = Array.from({ length: 3 }, (_, index) => ({
        id: `ref_${index}`,
        name: `reference-${index}.png`,
        url: `blob:ref-${index}`,
      }));
      const callbacks = { ...props(), references: full };
      render(<EditActionPanel {...callbacks} />);

      fireEvent.drop(screen.getByTestId("edit-references-strip"), { dataTransfer: dataTransfer([imageFile()]) });
      expect(callbacks.onReferencesChange).not.toHaveBeenCalled();
      expect(await screen.findByText(/references are full/i)).toBeInTheDocument();
    });
  });

  describe("enhance mode", () => {
    it("drops the prompt requirement and the reference strip, and shows the enhancement controls", () => {
      render(
        <EditActionPanel
          {...props()}
          mode="enhance"
          enhanceControls={
            <label>
              Details
              <input type="range" aria-label="Details" />
            </label>
          }
        />,
      );

      // Enhance is a General Enhancement job: no reference conditioning, and the
      // prompt is optional guidance rather than the instruction.
      expect(screen.queryByTestId("edit-references-strip")).not.toBeInTheDocument();
      expect(screen.getByText("optional")).toBeInTheDocument();
      expect(screen.getByRole("slider", { name: "Details" })).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", expect.stringContaining("read the image itself"));
    });

    it("keeps the enhancement controls out of inpaint, where they mean nothing", () => {
      render(<EditActionPanel {...props()} enhanceControls={<input aria-label="Details" type="range" />} />);
      expect(screen.queryByRole("slider", { name: "Details" })).not.toBeInTheDocument();
      expect(screen.getByTestId("edit-references-strip")).toBeInTheDocument();
    });
  });
});
