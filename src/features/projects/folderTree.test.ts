// The training layout is the case this exists for: every artist has a folder, and
// every artist's folder holds the same exercise subfolders.

import { describe, expect, it } from "vitest";
import { folderFilterScope, folderPathLabel, folderTreeEntries, isInFolderScope } from "./folderTree";

function folder(folderId: string, name: string, parentId: string | null = null, archived = false) {
  return { folderId, name, parentId, archived };
}

const training = [
  folder("sara", "Sara Haddad"),
  folder("omar", "Omar Khalil"),
  folder("sara_02", "02 Character Walk", "sara"),
  folder("sara_01", "01 Camera Moves", "sara"),
  folder("omar_01", "01 Camera Moves", "omar"),
  folder("omar_01_takes", "Takes", "omar_01"),
];

describe("folderTreeEntries", () => {
  it("lists each folder before its subfolders, siblings by name, labelled with the full path", () => {
    expect(folderTreeEntries(training).map((entry) => [entry.path, entry.depth])).toEqual([
      ["Omar Khalil", 0],
      ["Omar Khalil / 01 Camera Moves", 1],
      ["Omar Khalil / 01 Camera Moves / Takes", 2],
      ["Sara Haddad", 0],
      ["Sara Haddad / 01 Camera Moves", 1],
      ["Sara Haddad / 02 Character Walk", 1],
    ]);
  });

  it("gives same-named subfolders of different artists different labels", () => {
    const labels = folderTreeEntries(training)
      .filter((entry) => entry.folder.name === "01 Camera Moves")
      .map((entry) => entry.path);
    expect(new Set(labels).size).toBe(2);
  });

  it("leaves archived folders out but keeps a live child of an archived parent at the top level", () => {
    const entries = folderTreeEntries([folder("old", "Old"), folder("kept", "Kept", "gone"), folder("gone", "Gone", null, true)]);
    expect(entries.map((entry) => [entry.path, entry.depth])).toEqual([
      ["Gone / Kept", 0],
      ["Old", 0],
    ]);
  });

  it("survives a parent cycle", () => {
    const entries = folderTreeEntries([folder("a", "A", "b"), folder("b", "B", "a")]);
    expect(entries.map((entry) => entry.folder.folderId).sort()).toEqual(["a", "b"]);
  });
});

describe("folderPathLabel", () => {
  it("walks up to the top-level folder", () => {
    expect(folderPathLabel(training[5], training)).toBe("Omar Khalil / 01 Camera Moves / Takes");
  });

  it("stops at a missing parent", () => {
    expect(folderPathLabel(folder("x", "Orphan", "missing"), training)).toBe("Orphan");
  });
});

describe("folderFilterScope", () => {
  it("takes in every folder beneath the selected one", () => {
    const scope = folderFilterScope("omar", training);
    expect(isInFolderScope("omar", scope)).toBe(true);
    expect(isInFolderScope("omar_01", scope)).toBe(true);
    expect(isInFolderScope("omar_01_takes", scope)).toBe(true);
    expect(isInFolderScope("sara_01", scope)).toBe(false);
    expect(isInFolderScope(null, scope)).toBe(false);
  });

  it("includes archived subfolders", () => {
    const scope = folderFilterScope("sara", [...training, folder("sara_old", "Old", "sara", true)]);
    expect(isInFolderScope("sara_old", scope)).toBe(true);
  });

  it("keeps all and root meaning what they meant", () => {
    expect(isInFolderScope("sara", folderFilterScope("all", training))).toBe(true);
    expect(isInFolderScope(null, folderFilterScope("all", training))).toBe(true);
    expect(isInFolderScope(null, folderFilterScope("root", training))).toBe(true);
    expect(isInFolderScope("sara", folderFilterScope("root", training))).toBe(false);
  });

  it("still matches the folder itself when the project's folders are not loaded", () => {
    const scope = folderFilterScope("sara");
    expect(isInFolderScope("sara", scope)).toBe(true);
    expect(isInFolderScope("sara_01", scope)).toBe(false);
  });
});
