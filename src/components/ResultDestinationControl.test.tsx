// With a folder per artist, the destination list is a hundred entries long. The
// pinned group is what lets an artist find their own folder in it.

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Project } from "../types";
import { ResultDestinationControl } from "./ResultDestinationControl";

const project = {
  id: "proj_1",
  name: "Animation-Training",
  shortName: "2345",
  folders: [
    { folderId: "fld_omar", parentId: null, name: "Omar Khalil", archived: false },
    { folderId: "fld_sara", parentId: null, name: "Sara Haddad", archived: false },
    { folderId: "fld_sara_01", parentId: "fld_sara", name: "01 Camera Moves", archived: false },
  ],
} as unknown as Project;

function options(element: HTMLElement) {
  return within(element).getAllByRole("option").map((option) => option.textContent);
}

describe("ResultDestinationControl", () => {
  it("puts a pinned folder and its subfolders in a Pinned group on top", () => {
    render(
      <ResultDestinationControl
        selectedProject={project}
        targetFolderId=""
        onTargetFolderChange={vi.fn()}
        pinnedFolderKeys={["proj_1:fld_sara"]}
      />,
    );

    const destination = screen.getByRole("combobox", { name: "Save result to" });
    expect(options(destination)).toEqual(["Root", "Sara Haddad", "Sara Haddad / 01 Camera Moves", "Omar Khalil"]);
    expect(options(screen.getByRole("group", { name: "Pinned" }))).toEqual([
      "Sara Haddad",
      "Sara Haddad / 01 Camera Moves",
    ]);
  });

  it("stays one flat list when nothing is pinned", () => {
    render(<ResultDestinationControl selectedProject={project} targetFolderId="" onTargetFolderChange={vi.fn()} />);

    expect(screen.queryByRole("group", { name: "Pinned" })).toBeNull();
    expect(options(screen.getByRole("combobox", { name: "Save result to" }))).toEqual([
      "Root",
      "Omar Khalil",
      "Sara Haddad",
      "Sara Haddad / 01 Camera Moves",
    ]);
  });

  it("names the pinned destination by its full path in the summary", () => {
    render(
      <ResultDestinationControl
        selectedProject={project}
        targetFolderId="fld_sara_01"
        onTargetFolderChange={vi.fn()}
        pinnedFolderKeys={["proj_1:fld_sara"]}
      />,
    );

    expect(screen.getByText(/Saving to 2345_Animation-Training \/ Sara Haddad \/ 01 Camera Moves/)).toBeInTheDocument();
  });
});
