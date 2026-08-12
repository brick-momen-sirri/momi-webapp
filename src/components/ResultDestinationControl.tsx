import { AlertCircle, FolderCheck } from "lucide-react";
import { sortFoldersByName } from "../features/projects/folderSort";
import type { Project } from "../types";

type ResultDestinationControlProps = {
  selectedProject?: Project;
  targetFolderId: string;
  onTargetFolderChange: (folderId: string) => void;
};

export function ResultDestinationControl({
  selectedProject,
  targetFolderId,
  onTargetFolderChange,
}: ResultDestinationControlProps) {
  const activeFolders = sortFoldersByName(
    (selectedProject?.folders ?? []).filter((folder) => !folder.archived),
  );
  const targetFolder = activeFolders.find((folder) => folder.folderId === targetFolderId);

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
            {activeFolders.map((folder) => (
              <option key={folder.folderId} value={folder.folderId}>
                {folder.name}
              </option>
            ))}
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
                ? `Saving to ${selectedProject.shortName}_${selectedProject.name.replaceAll(" ", "_")}${targetFolder ? ` / ${targetFolder.name}` : ""}`
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
