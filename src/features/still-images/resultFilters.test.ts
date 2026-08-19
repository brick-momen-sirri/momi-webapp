import { describe, expect, it } from "vitest";

import type { Job } from "../../types";
import { POD_RUNTIME_SOURCE } from "./podRuntimeCost";
import {
  DEFAULT_STILL_IMAGE_RESULT_FILTERS,
  filterStillImageJobs,
  hasActiveStillImageFilters,
  ROOT_FOLDER_FILTER,
  STILL_IMAGE_PRESET_FILTER_OPTIONS,
} from "./resultFilters";

// A project's results are a flat list of large cards, so finding one among thirty
// is entirely down to these rules. The cases that matter are the ones an artist
// actually asks for: this preset, the failed one, the 0012 take, that seed.

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    projectId: "prj_1",
    userId: "usr_1",
    modelType: "General Enhancement",
    prompt: "",
    status: "completed",
    inputImages: [],
    createdAt: "2026-08-14T10:00:00.000Z",
    folderId: null,
    workflowOptions: {
      stillImage: { categoryId: "general-enhancement", settings: {} },
      save: { cameraNumber: "0001" },
    },
    ...overrides,
  } as Job;
}

const filters = (overrides: Partial<typeof DEFAULT_STILL_IMAGE_RESULT_FILTERS> = {}) => ({
  ...DEFAULT_STILL_IMAGE_RESULT_FILTERS,
  ...overrides,
});

describe("filterStillImageJobs", () => {
  it("keeps everything and orders newest first by default", () => {
    const older = job({ id: "older", createdAt: "2026-08-10T10:00:00.000Z" });
    const newer = job({ id: "newer", createdAt: "2026-08-14T10:00:00.000Z" });

    expect(filterStillImageJobs([older, newer], filters()).map((item) => item.id)).toEqual(["newer", "older"]);
    expect(filterStillImageJobs([older, newer], filters({ sort: "oldest" })).map((item) => item.id)).toEqual(["older", "newer"]);
  });

  it("narrows to one preset", () => {
    const upscale = job({
      id: "upscale",
      workflowOptions: { stillImage: { categoryId: "pro-upscaler", settings: {} } },
    });

    const found = filterStillImageJobs([job(), upscale], filters({ presetId: "pro-upscaler" }));
    expect(found.map((item) => item.id)).toEqual(["upscale"]);
  });

  it("groups canceled with failed, because neither produced a result", () => {
    const failed = job({ id: "failed", status: "failed" });
    const canceled = job({ id: "canceled", status: "canceled" });
    const running = job({ id: "running", status: "running" });
    const queued = job({ id: "queued", status: "queued" });
    const all = [job({ id: "done" }), failed, canceled, running, queued];

    expect(filterStillImageJobs(all, filters({ status: "failed" })).map((item) => item.id)).toEqual(["failed", "canceled"]);
    // "Working" is anything still in flight, whichever stage it is at.
    expect(filterStillImageJobs(all, filters({ status: "working" })).map((item) => item.id)).toEqual(["running", "queued"]);
    expect(filterStillImageJobs(all, filters({ status: "completed" })).map((item) => item.id)).toEqual(["done"]);
  });

  it("separates the project root from a named folder", () => {
    const inFolder = job({ id: "in_folder", folderId: "fld_1", folderName: "Interiors" });
    const atRoot = job({ id: "at_root", folderId: null });

    expect(filterStillImageJobs([inFolder, atRoot], filters({ folderId: ROOT_FOLDER_FILTER })).map((i) => i.id)).toEqual([
      "at_root",
    ]);
    expect(filterStillImageJobs([inFolder, atRoot], filters({ folderId: "fld_1" })).map((i) => i.id)).toEqual(["in_folder"]);
  });

  it("searches the things an artist refers to a render by", () => {
    const target = job({
      id: "target",
      fileName: "20260814_pro-upscaler_1234_cam-12_v001.png",
      prompt: "warmer evening light on the facade",
      workflowOptions: {
        stillImage: { categoryId: "qwen-edit", settings: { mode: "consistency" } },
        save: { cameraNumber: "0012" },
      },
    });
    const other = job({ id: "other", prompt: "sharper interior detail" });
    const both = [target, other];

    // The camera number, which is how these are named and discussed.
    expect(filterStillImageJobs(both, filters({ query: "0012" })).map((i) => i.id)).toEqual(["target"]);
    // The prompt, case-insensitively.
    expect(filterStillImageJobs(both, filters({ query: "FACADE" })).map((i) => i.id)).toEqual(["target"]);
    // The filename the backend saved it as.
    expect(filterStillImageJobs(both, filters({ query: "cam-12" })).map((i) => i.id)).toEqual(["target"]);
    // The Qwen mode, which is a badge on the card and searchable nowhere else.
    expect(filterStillImageJobs(both, filters({ query: "consistency" })).map((i) => i.id)).toEqual(["target"]);
  });

  it("finds a render by the seed it was made with", () => {
    // The whole point of recording seeds is reproducing a take, and the seed is
    // otherwise only readable by scrolling to the card.
    const seeded = job({
      id: "seeded",
      workflowOptions: { stillImage: { categoryId: "general-enhancement", seed: 184992, settings: {} } },
    });

    expect(filterStillImageJobs([seeded, job({ id: "other" })], filters({ query: "184992" })).map((i) => i.id)).toEqual([
      "seeded",
    ]);
  });

  it("orders by measured cost, sinking the runs nobody priced", () => {
    const cheap = job({ id: "cheap", creditsActual: 12, creditsActualSource: POD_RUNTIME_SOURCE });
    const dear = job({ id: "dear", creditsActual: 96, creditsActualSource: POD_RUNTIME_SOURCE });
    // Most runs look like this until a pod has a per-second price configured, and
    // reading them as free would put them above the cheap one.
    const uncosted = job({ id: "uncosted", creditsEstimated: 24 });

    expect(filterStillImageJobs([cheap, uncosted, dear], filters({ sort: "cost" })).map((i) => i.id)).toEqual([
      "dear",
      "cheap",
      "uncosted",
    ]);
  });

  it("combines filters rather than picking one", () => {
    const wanted = job({ id: "wanted", status: "failed", folderId: "fld_1" });
    const all = [
      wanted,
      job({ id: "right_folder_wrong_status", folderId: "fld_1" }),
      job({ id: "right_status_wrong_folder", status: "failed" }),
    ];

    const found = filterStillImageJobs(all, filters({ status: "failed", folderId: "fld_1" }));
    expect(found.map((item) => item.id)).toEqual(["wanted"]);
  });
});

describe("the two personal filters", () => {
  // Neither can be read off a job: favourites are stored per browser and the account
  // is App's, so both come in as viewer context. The failure worth guarding is a
  // filter that silently matches everything when that context is missing.
  const mine = job({ id: "job_mine", userId: "usr_momen" });
  const theirs = job({ id: "job_theirs", userId: "usr_other" });

  it("keeps only starred results", () => {
    const starred = filterStillImageJobs([mine, theirs], filters({ favoritesOnly: true }), {
      favoriteJobIds: new Set(["job_theirs"]),
    });
    expect(starred.map((entry) => entry.id)).toEqual(["job_theirs"]);
  });

  it("keeps only this account's results", () => {
    const own = filterStillImageJobs([mine, theirs], filters({ mineOnly: true }), { currentUserId: "usr_momen" });
    expect(own.map((entry) => entry.id)).toEqual(["job_mine"]);
  });

  it("narrows to nothing rather than everything when the viewer is unknown", () => {
    // The panel does not offer either switch without the context behind it, so this
    // is the belt-and-braces case: on, with nothing to compare against, must not read
    // as "no filter" and quietly show someone else's work as their own.
    expect(filterStillImageJobs([mine, theirs], filters({ favoritesOnly: true }))).toEqual([]);
    expect(filterStillImageJobs([mine, theirs], filters({ mineOnly: true }))).toEqual([]);
  });

  it("intersects with each other and with the rest", () => {
    const both = filterStillImageJobs(
      [mine, theirs, job({ id: "job_mine_unstarred", userId: "usr_momen" })],
      filters({ favoritesOnly: true, mineOnly: true }),
      { favoriteJobIds: new Set(["job_mine", "job_theirs"]), currentUserId: "usr_momen" },
    );
    expect(both.map((entry) => entry.id)).toEqual(["job_mine"]);
  });
});

describe("hasActiveStillImageFilters", () => {
  it("ignores sort order, which hides nothing", () => {
    // Sort must not light up "Clear filters" or make the header claim a subset:
    // reordering a list still shows every result in it.
    expect(hasActiveStillImageFilters(filters({ sort: "cost" }))).toBe(false);
    expect(hasActiveStillImageFilters(filters())).toBe(false);
    expect(hasActiveStillImageFilters(filters({ query: "  " }))).toBe(false);
    expect(hasActiveStillImageFilters(filters({ query: "cam-12" }))).toBe(true);
    expect(hasActiveStillImageFilters(filters({ status: "failed" }))).toBe(true);
  });

  it("counts the personal filters, which hide plenty", () => {
    // Both must light up Clear and make the header say "n of m": a panel showing four
    // of forty results with no visible reason is how someone concludes the rest were
    // deleted.
    expect(hasActiveStillImageFilters(filters({ favoritesOnly: true }))).toBe(true);
    expect(hasActiveStillImageFilters(filters({ mineOnly: true }))).toBe(true);
  });
});

describe("STILL_IMAGE_PRESET_FILTER_OPTIONS", () => {
  it("offers every preset in the catalogue, so none can be unfilterable", () => {
    expect(STILL_IMAGE_PRESET_FILTER_OPTIONS.map((option) => option.value)).toEqual([
      "general-enhancement",
      "pro-upscaler",
      "reference-generator",
      "qwen-edit",
    ]);
  });
});
