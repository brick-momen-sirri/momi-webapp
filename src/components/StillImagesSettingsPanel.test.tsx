import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendMaskStroke, createMaskDrawing } from "../features/still-images/maskDrawing";
import { createInitialStillImagesState, getStillImageCategory } from "../features/still-images/stillImageCategories";
import { useStillImagesForm } from "../features/still-images/useStillImagesForm";
import type { Project, UploadedImage } from "../types";
import { StillImagesSettingsPanel } from "./StillImagesSettingsPanel";
import { StillImagesWorkspace } from "./StillImagesWorkspace";

const generateCalls: number[] = [];

function StillImagesHarness() {
  const form = useStillImagesForm();

  return (
    <>
      <StillImagesSettingsPanel
        selectedCategoryId={form.selectedCategoryId}
        category={form.selectedCategory}
        state={form.selectedState}
        targetFolderId={form.targetFolderId}
        saveNumber={form.saveNumber}
        onCategoryChange={form.setSelectedCategoryId}
        onImagesChange={form.setImages}
        onMaskChange={form.setMask}
        onPromptChange={form.setPrompt}
        onSeedChange={form.setSeed}
        onSettingChange={form.setSetting}
        onTargetFolderChange={form.setTargetFolderId}
        onSaveNumberChange={form.setSaveNumber}
        onGenerate={() => generateCalls.push(Date.now())}
      />
      <StillImagesWorkspace
        category={form.selectedCategory}
        state={form.selectedState}
        targetFolderId={form.targetFolderId}
        saveNumber={form.saveNumber}
        userName="Test User"
        jobs={[]}
      />
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StillImagesSettingsPanel", () => {
  it("keeps category state isolated and the Generate button disabled", async () => {
    const user = userEvent.setup();
    render(<StillImagesHarness />);

    await user.type(screen.getByRole("textbox", { name: "Enhancement prompt" }), "preserve stone texture");
    await user.click(screen.getByRole("button", { name: "Flux 2 Klein Edit" }));
    await user.type(screen.getByRole("textbox", { name: "Edit prompt" }), "replace the sky");
    await user.click(screen.getByRole("button", { name: "General Enhancement" }));

    expect(screen.getByRole("textbox", { name: "Enhancement prompt" })).toHaveValue("preserve stone texture");
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("does not make a request while configuring the frontend-only workflow", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<StillImagesHarness />);

    await user.click(screen.getByRole("button", { name: "Reference Generator" }));
    await user.click(screen.getByTitle("Paste image from clipboard"));
    await user.click(screen.getByRole("button", { name: "Flux 2 Klein Edit" }));
    await user.selectOptions(screen.getByLabelText("Image count"), "3");
    await user.type(screen.getByRole("textbox", { name: "Edit prompt" }), "make the facade warmer");

    expect(screen.getByLabelText("Upload Image 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mirrors every Flux 2 Klein Edit mode and its Forge input rules", async () => {
    const user = userEvent.setup();
    render(<StillImagesHarness />);
    await user.click(screen.getByRole("button", { name: "Flux 2 Klein Edit" }));

    const mode = screen.getByLabelText("Mode");
    expect(screen.getByLabelText("Image count")).toBeInTheDocument();

    await user.selectOptions(mode, "reference-transfer");
    expect(screen.queryByLabelText("Image count")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Edit prompt" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Upload Main image")).toBeInTheDocument();
    expect(screen.getByLabelText("Upload Reference image")).toBeInTheDocument();

    await user.selectOptions(mode, "consistency");
    expect(screen.getByRole("textbox", { name: "Edit prompt" })).toBeInTheDocument();
    expect(screen.getByLabelText("Upload Consistency image")).toBeInTheDocument();
    expect(screen.queryByLabelText("Upload Reference image")).not.toBeInTheDocument();

    await user.selectOptions(mode, "raw-enhancement");
    expect(screen.getByRole("textbox", { name: "Edit prompt" })).toBeInTheDocument();
    expect(screen.getByLabelText("Upload Raw render")).toBeInTheDocument();

    await user.selectOptions(mode, "realistic");
    expect(screen.getByLabelText("Upload Image to make realistic")).toBeInTheDocument();
    expect(screen.getByLabelText("Realistic Mode")).toHaveValue("0.5");
    expect(screen.getByLabelText("Realistic prompt category")).toBeInTheDocument();
    expect(screen.getByLabelText("Realistic prompt preset")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Realistic prompt category"), "night");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit prompt" }).value).toContain("deep blue night sky");

    await user.selectOptions(mode, "edit");
    await user.selectOptions(screen.getByLabelText("Image count"), "3");
    expect(screen.getByLabelText("Upload Image 3")).toBeInTheDocument();
  });

  it("offers one upload slot for Image Editing and paints the rest", async () => {
    const user = userEvent.setup();
    render(<StillImagesHarness />);

    await user.click(screen.getByRole("button", { name: "Image Editing Studio" }));

    // Slots 2 and 3 are the mask and the marked guide, both drawn from the region
    // the artist paints. Offering them as uploads would ask for files that do not
    // exist and that nothing outside this panel knows how to make.
    expect(screen.getByLabelText("Upload Source image")).toBeInTheDocument();
    expect(screen.queryByLabelText("Upload Edit mask")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Upload Marked guide")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current composite & region" })).toBeInTheDocument();

    // Mask settings and actions now live inside the full-screen studio rather
    // than leaking implementation slots into the sidebar uploader.
    expect(screen.queryByRole("checkbox", { name: /show the model where/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Upload Source image")).toBeInTheDocument();
    expect(screen.queryByLabelText("Upload Edit mask")).not.toBeInTheDocument();
  });

  it("keeps Image Editing generation inside the composite studio", () => {
    const category = getStillImageCategory("image-editing");
    const base = createInitialStillImagesState()["image-editing"];
    const image: UploadedImage = { id: "img_1", name: "shot.png", url: "blob:shot" };
    const props = {
      selectedCategoryId: "image-editing" as const,
      category,
      selectedProject: { id: "proj_1", name: "Tower", folders: [] } as unknown as Project,
      targetFolderId: "",
      saveNumber: "0012",
      onCategoryChange: () => undefined,
      onImagesChange: () => undefined,
      onMaskChange: () => undefined,
      onPromptChange: () => undefined,
      onSeedChange: () => undefined,
      onSettingChange: () => undefined,
      onTargetFolderChange: () => undefined,
      onSaveNumberChange: () => undefined,
      onGenerate: () => undefined,
    };

    // Nothing yet: the editor explains what to upload and does not expose the
    // disconnected sidebar Generate action.
    const empty = render(<StillImagesSettingsPanel {...props} state={base} />);
    expect(screen.getByText(/upload a source image above/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate" })).not.toBeInTheDocument();
    empty.unmount();

    const painted = {
      ...base,
      images: [image],
      mask: appendMaskStroke(createMaskDrawing(800, 600), { tool: "brush" as const, radius: 20, points: [{ x: 10, y: 10 }] }),
    };
    render(<StillImagesSettingsPanel {...props} state={painted} />);
    expect(screen.queryByRole("button", { name: "Generate" })).not.toBeInTheDocument();
  });

  it("holds a seed per preset and refuses what the server would reject", async () => {
    const user = userEvent.setup();
    render(<StillImagesHarness />);

    const seed = () => screen.getByRole("textbox", { name: "Seed" });
    // Empty is the normal state: the server draws one and records it on the job.
    expect(seed()).toHaveValue("");
    // Nothing to clear, and nothing to step from. Stepping an empty field would pin
    // a seed the artist never chose.
    expect(screen.getByRole("button", { name: "Clear seed" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next seed" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous seed" })).toBeDisabled();

    // Seeds get pasted out of a card's metadata row, so the field takes what a
    // paste brings with it rather than rejecting the whole thing.
    await user.type(seed(), "seed 1-234");
    expect(seed()).toHaveValue("1234");

    // Walking to a neighbouring take, which is what stepping is for.
    await user.click(screen.getByRole("button", { name: "Next seed" }));
    expect(seed()).toHaveValue("1235");
    await user.click(screen.getByRole("button", { name: "Previous seed" }));
    expect(seed()).toHaveValue("1234");

    // Clamped here rather than at submission, which is after the artist has set
    // up the inputs and pressed Generate.
    await user.clear(seed());
    await user.type(seed(), "99999999999");
    expect(seed()).toHaveValue("4294967295");
    // Including the step: the server rejects anything past this, and the ceiling is
    // a real seed rather than a value to refuse.
    await user.click(screen.getByRole("button", { name: "Next seed" }));
    expect(seed()).toHaveValue("4294967295");

    // Pinned on demand, so exploring a setting around one take does not depend on
    // having a finished card to read a seed off.
    await user.click(screen.getByRole("button", { name: "Random" }));
    // Whole digits in range, whatever was drawn -- anything else is a seed the server
    // refuses, which would only surface after the inputs were set up.
    const drawn = (seed() as HTMLInputElement).value;
    expect(drawn).toMatch(/^\d+$/);
    expect(Number(drawn)).toBeLessThanOrEqual(4294967295);

    await user.click(screen.getByRole("button", { name: "Clear seed" }));
    expect(seed()).toHaveValue("");

    // Per preset, like the prompt and the sliders next to it.
    await user.type(seed(), "77");
    await user.click(screen.getByRole("button", { name: "Flux 2 Klein Edit" }));
    expect(screen.getByRole("textbox", { name: "Seed" })).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "General Enhancement" }));
    expect(screen.getByRole("textbox", { name: "Seed" })).toHaveValue("77");
  });

  it("reveals the body and face enhancement sliders behind their checkbox", async () => {
    // The panel builds its controls from the catalogue rather than hard-coding
    // them, so this covers that the ported forge settings actually render and
    // stay hidden until their branch is switched on.
    const user = userEvent.setup();
    render(<StillImagesHarness />);

    expect(screen.queryByLabelText("Body enhancement")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Face enhancement")).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Enable body enhancement"));
    expect(screen.getByLabelText("Body enhancement")).toBeInTheDocument();
    expect(screen.getByLabelText("Face enhancement")).toBeInTheDocument();

    // Independent of the other two branches, which are what forge's routing
    // matrix combines it with.
    expect(screen.getByLabelText("Enable general enhancement")).toBeChecked();
    expect(screen.getByLabelText("Advanced details")).not.toBeChecked();

    await user.click(screen.getByLabelText("Enable body enhancement"));
    expect(screen.queryByLabelText("Body enhancement")).not.toBeInTheDocument();
  });
});
