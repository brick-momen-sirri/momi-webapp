// Folder ordering for every surface that lists a project's subfolders.
//
// Folders arrive from the API in creation order, which is unusable once a
// project holds 60+ shot folders: "4315" sits wherever it happened to be
// created rather than between "4305" and "4400". Shot folders are named with
// numbers ("1400", "4105", "4315") alongside the odd word folder ("Lookdev"),
// so a plain localeCompare is not enough either -- it would order "1400" after
// "980" because it compares digit by digit.
//
// Intl.Collator with numeric:true compares runs of digits as numbers, which
// gives the ordering people expect: numeric folders ascending, then named
// folders alphabetically. sensitivity "base" keeps "lookdev" and "Lookdev"
// adjacent instead of grouping all capitals first.
//
// Locale is pinned to "en" so the ordering does not shift with the host
// machine's locale.
const folderCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function compareFolderNames(left: string, right: string) {
  return folderCollator.compare(left, right);
}

// Array.prototype.sort is stable, so folders whose names compare equal keep
// their incoming (creation) order.
export function sortFoldersByName<T extends { name: string }>(folders: readonly T[]): T[] {
  return [...folders].sort((left, right) => compareFolderNames(left.name, right.name));
}
