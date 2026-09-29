import { AlertCircle, FolderCheck } from "lucide-react";
import { folderTreeEntries, pinnedFolderIdsIn } from "../features/projects/folderTree";
import type { Project } from "../types";

type ResultDestinationControlProps = {
  selectedProject?: Project;
  targetFolderId: string;
  onTargetFolderChange: (folderId: string) => void;
  /** This account's pinned top-level folders, as folderPinKey(projectId, folderId). */
  pinnedFolderKeys?: string[];
};

export function ResultDestinationControl({
  selectedProject,
  targetFolderId,
  onTargetFolderChange,
  pinnedFolderKeys,
}: ResultDestinationControlProps) {
  // Full paths, not bare names: with a folder per artist and the same exercise
  // subfolders in each, "01 Camera Moves" alone does not say whose it is.
  const folderEntries = folderTreeEntries(
    selectedProject?.folders ?? [],
    pinnedFolderIdsIn(selectedProject?.id, pinnedFolderKeys),
  );
  const targetFolder = folderEntries.find((entry) => entry.folder.folderId === targetFolderId);
  // A pinned folder's branch gets its own group on top, so an artist finds their
  // folder without scrolling past a hundred others.
  const pinnedEntries = folderEntries.filter((entry) => entry.pinned);
  const otherEntries = folderEntries.filter((entry) => !entry.pinned);
  const folderOptions = (entries: typeof folderEntries) =>
    entries.map((entry) => (
      <option key={entry.folder.folderId} value={entry.folder.folderId}>
        {entry.path}
      </option>
    ));

  return (
    <>
      {selectedProject ? (
        <label className="block rounded-lg border border-line bg-white p-3 shadow-panel">
          <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">Save result to</span>
          <select
            value={targetFolderId}
            onChange={(event) => onTargetFolderChange(event.target.value)}
            className="mt-2 h-10 w-full rounded-md border border-line bg-white px-3 text-sm font-semibold outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
          >
            <option value="">Root</option>
            {pinnedEntries.length ? (
              <>
                <optgroup label="Pinned">{folderOptions(pinnedEntries)}</optgroup>
                <optgroup label="All folders">{folderOptions(otherEntries)}</optgroup>
              </>
            ) : (
              folderOptions(otherEntries)
            )}
          </select>
        </label>
      ) : null}

      <div
        className={`rounded-lg border p-3 shadow-panel ${selectedProject ? "border-teal-100 bg-teal-50" : "border-amber-200 bg-amber-50"}`}
      >
        <div className="flex items-start gap-2">
          {selectedProject ? (
            <FolderCheck className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
          ) : (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" />
          )}
          <div>
            <p className={`text-xs font-semibold ${selectedProject ? "text-teal-800" : "text-amber-900"}`}>
              {selectedProject
                ? `Saving to ${selectedProject.shortName}_${selectedProject.name.replaceAll(" ", "_")}${targetFolder ? ` / ${targetFolder.path}` : ""}`
                : "Please select a specific project before generating."}
            </p>
            <p className={`mt-1 text-xs leading-5 ${selectedProject ? "text-teal-700" : "text-amber-800"}`}>
              Every result is stored with jobs, inputs, results, thumbnails, and metadata in the selected project folder.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
