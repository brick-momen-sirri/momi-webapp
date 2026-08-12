// Shot folders are numbered, and a project holds 60+ of them. Ordering them as
// plain strings is the failure this helper exists to prevent, so the numeric
// cases below are the point of the test, not incidental coverage.

import { describe, expect, it } from "vitest";
import { compareFolderNames, sortFoldersByName } from "./folderSort";

function names(folders: { name: string }[]) {
  return sortFoldersByName(folders).map((folder) => folder.name);
}

describe("sortFoldersByName", () => {
  it("orders numeric shot folders by value, not by digit", () => {
    expect(names([{ name: "4315" }, { name: "980" }, { name: "1400" }, { name: "4305" }])).toEqual([
      "980",
      "1400",
      "4305",
      "4315",
    ]);
  });

  it("puts numeric folders before named ones", () => {
    expect(names([{ name: "Lookdev" }, { name: "4000" }, { name: "Anim" }, { name: "1200" }])).toEqual([
      "1200",
      "4000",
      "Anim",
      "Lookdev",
    ]);
  });

  it("ignores case when ordering named folders", () => {
    expect(names([{ name: "lookdev" }, { name: "Anim" }, { name: "BUILD" }])).toEqual([
      "Anim",
      "BUILD",
      "lookdev",
    ]);
  });

  it("keeps creation order for folders with the same name", () => {
    const first = { name: "4100", folderId: "a" };
    const second = { name: "4100", folderId: "b" };
    expect(sortFoldersByName([first, second])).toEqual([first, second]);
  });

  it("handles mixed number-and-word names like 4300_extra", () => {
    expect(names([{ name: "4300_extra" }, { name: "4300" }, { name: "4300b" }, { name: "4295" }])).toEqual([
      "4295",
      "4300",
      "4300_extra",
      "4300b",
    ]);
  });

  it("does not mutate the input array", () => {
    const folders = [{ name: "4315" }, { name: "1400" }];
    sortFoldersByName(folders);
    expect(folders.map((folder) => folder.name)).toEqual(["4315", "1400"]);
  });
});

describe("compareFolderNames", () => {
  // MoveResultMenu sorts by full "parent / child" path, so the comparator has to
  // hold up on strings that are not bare folder names.
  it("orders nested paths numerically at every level", () => {
    const paths = ["Seq_2 / 1400", "Seq_10 / 980", "Seq_2 / 980"];
    expect([...paths].sort(compareFolderNames)).toEqual(["Seq_2 / 980", "Seq_2 / 1400", "Seq_10 / 980"]);
  });
});
