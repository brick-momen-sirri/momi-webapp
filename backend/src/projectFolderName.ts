import path from "node:path";

// Project folder paths are stored with the deployment host's separators
// (Windows in prod, e.g. C:\ComfyUI\output\projects\<name>). path.win32.basename
// treats BOTH "\" and "/" as separators on any OS, so this returns the folder
// name whether the code runs on Windows (prod) or Linux (CI / tests). Plain
// path.basename is POSIX on Linux and would return the whole Windows path.
// Behavior on Windows is identical to path.basename, so this is a drop-in.
export function projectFolderName(folderPath: string | null | undefined): string {
  return path.win32.basename(folderPath ?? "");
}
