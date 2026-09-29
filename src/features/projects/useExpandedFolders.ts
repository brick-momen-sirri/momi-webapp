// Which folders are open in the project panel's folder list.
//
// A project with a folder per artist, each holding their shot folders, is several
// hundred rows when everything is shown. So folders start collapsed and each one
// opens on its own; what was left open is remembered in this browser, since it is
// a view preference rather than anything about the project. Keys are
// folderPinKey(projectId, folderId), as folder ids are only unique per project.

import { useState } from "react";

const EXPANDED_FOLDERS_STORAGE_KEY = "momi_expanded_folders_v1";

export function useExpandedFolders() {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(readExpandedFolders);

  const update = (next: Set<string>) => {
    setExpanded(next);
    writeExpandedFolders(next);
  };

  return {
    isExpanded: (key: string) => expanded.has(key),
    toggle: (key: string) => {
      const next = new Set(expanded);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      update(next);
    },
    expand: (key: string) => {
      if (!expanded.has(key)) update(new Set(expanded).add(key));
    },
  };
}

function readExpandedFolders(): ReadonlySet<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_FOLDERS_STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeExpandedFolders(keys: ReadonlySet<string>) {
  if (typeof window === "undefined") return;
  try {
    // Capped so a long-lived browser cannot grow this without bound.
    window.localStorage.setItem(EXPANDED_FOLDERS_STORAGE_KEY, JSON.stringify(Array.from(keys).slice(-500)));
  } catch {
    // Browser storage can fail in private mode or when the quota is full.
  }
}
