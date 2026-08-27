import { describe, expect, it } from "vitest";

import {
  editDocumentIdOfJob,
  editDocumentsFromJobs,
  editSessionCost,
  isFinalizedCompositeJob,
  restoreEditDocument,
} from "./editDocument";
import type { Job, StillImageEditBaseLayer } from "../../types";

const ORIGINAL = "/api/media?path=original.png";

function layerJob(options: {
  layerId: string;
  at: string;
  documentId?: string;
  prompt?: string;
  baseLayers?: StillImageEditBaseLayer[];
  crop?: string;
  status?: Job["status"];
  generated?: boolean;
}): Job {
  const baseLayers = options.baseLayers ?? [];
  return {
    id: `job_${options.layerId}_${options.at}`,
    projectId: "prj_1",
    userId: "usr_1",
    modelType: "Image Editing",
    inputType: "multi_image",
    prompt: options.prompt ?? `edit ${options.layerId}`,
    resolution: "Unknown",
    status: options.status ?? "completed",
    inputImages: [],
    createdAt: options.at,
    completedAt: options.at,
    workflowOptions: {
      stillImage: {
        categoryId: "image-editing",
        settings: {},
        edit: {
          layerId: options.layerId,
          operation: "create",
          mode: "inpaint",
          documentId: options.documentId ?? "editdoc_1",
          crop: { x: 10, y: 20, size: 100, width: 100, height: 100, sourceWidth: 1200, sourceHeight: 800 },
          mask: { width: 1200, height: 800, softness: 35, strokes: [] },
          originalSourceUrl: ORIGINAL,
          maskSourceUrl: `/api/media?path=${options.layerId}-mask.png`,
          baseLayerIds: baseLayers.map((entry) => entry.layerId),
          baseLayers,
          referenceSourceUrls: [],
          ...(options.generated === false ? {} : { generatedCropUrl: `/api/media?path=${options.layerId}-crop.png` }),
        },
      },
    },
  } as Job;
}

function base(layerId: string, extra: Partial<StillImageEditBaseLayer> = {}): StillImageEditBaseLayer {
  return {
    layerId,
    crop: { x: 10, y: 20, size: 100, width: 100, height: 100, sourceWidth: 1200, sourceHeight: 800 },
    generatedCropUrl: `/api/media?path=${layerId}-crop.png`,
    maskSourceUrl: `/api/media?path=${layerId}-mask.png`,
    ...extra,
  };
}

function finalizedJob(documentId = "editdoc_1"): Job {
  return {
    id: "job_final",
    projectId: "prj_1",
    userId: "usr_1",
    modelType: "Current Composite & Mask",
    inputType: "single_image",
    prompt: "",
    resolution: "Unknown",
    status: "completed",
    inputImages: [ORIGINAL],
    createdAt: "2026-08-27T12:00:00.000Z",
    completedAt: "2026-08-27T12:00:00.000Z",
    workflowOptions: { stillImage: { categoryId: "image-editing", settings: { finalizedComposite: true, documentId } } },
  } as Job;
}

describe("finding a document", () => {
  it("reads the id off a layer job and off the composite it was flattened into", () => {
    expect(editDocumentIdOfJob(layerJob({ layerId: "a", at: "2026-08-27T10:00:00.000Z" }))).toBe("editdoc_1");
    expect(editDocumentIdOfJob(finalizedJob())).toBe("editdoc_1");
    expect(isFinalizedCompositeJob(finalizedJob())).toBe(true);
    expect(isFinalizedCompositeJob(layerJob({ layerId: "a", at: "2026-08-27T10:00:00.000Z" }))).toBe(false);
  });

  it("ignores a job that belongs to no document", () => {
    expect(editDocumentIdOfJob({ workflowOptions: { stillImage: { categoryId: "pro-upscaler", settings: {} } } } as Job)).toBe(
      undefined,
    );
  });

  it("lists documents newest first, counting the composite as part of its own", () => {
    const documents = editDocumentsFromJobs([
      layerJob({ layerId: "a", at: "2026-08-27T10:00:00.000Z" }),
      layerJob({ layerId: "x", at: "2026-08-27T09:00:00.000Z", documentId: "editdoc_0" }),
      finalizedJob(),
    ]);
    expect(documents.map((entry) => entry.documentId)).toEqual(["editdoc_1", "editdoc_0"]);
    expect(documents[0].jobs).toHaveLength(2);
  });
});

describe("rebuilding the stack", () => {
  it("restores a layer per generated take, in creation order, on its original", () => {
    const document = restoreEditDocument(
      [
        layerJob({ layerId: "edit_a", at: "2026-08-27T10:00:00.000Z", prompt: "replace the sky" }),
        layerJob({ layerId: "edit_b", at: "2026-08-27T11:00:00.000Z", baseLayers: [base("edit_a")] }),
      ],
      "editdoc_1",
    );

    expect(document?.originalSourceUrl).toBe(ORIGINAL);
    expect(document?.layers.map((layer) => layer.id)).toEqual(["edit_a", "edit_b"]);
    expect(document?.layers.map((layer) => layer.order)).toEqual([0, 1]);
    expect(document?.layers[0]).toMatchObject({
      name: "replace the sky",
      documentId: "editdoc_1",
      visible: true,
      opacity: 100,
      generatedCropSourceUrl: "/api/media?path=edit_a-crop.png",
      maskSourceUrl: "/api/media?path=edit_a-mask.png",
    });
  });

  it("keeps only the newest take of a regenerated layer", () => {
    const document = restoreEditDocument(
      [
        layerJob({ layerId: "edit_a", at: "2026-08-27T10:00:00.000Z", prompt: "first try" }),
        layerJob({ layerId: "edit_a", at: "2026-08-27T11:30:00.000Z", prompt: "second try" }),
      ],
      "editdoc_1",
    );
    expect(document?.layers).toHaveLength(1);
    expect(document?.layers[0].prompt).toBe("second try");
  });

  it("skips a job that never produced pixels", () => {
    const document = restoreEditDocument(
      [
        layerJob({ layerId: "edit_a", at: "2026-08-27T10:00:00.000Z" }),
        layerJob({ layerId: "edit_b", at: "2026-08-27T11:00:00.000Z", status: "failed", generated: false }),
      ],
      "editdoc_1",
    );
    expect(document?.layers.map((layer) => layer.id)).toEqual(["edit_a"]);
  });

  it("recovers opacity and position from whatever was generated on top", () => {
    // edit_c froze the stack beneath it, and that snapshot is the only record
    // that edit_a was taken to 40% and nudged.
    const document = restoreEditDocument(
      [
        layerJob({ layerId: "edit_a", at: "2026-08-27T10:00:00.000Z" }),
        layerJob({ layerId: "edit_b", at: "2026-08-27T10:30:00.000Z" }),
        layerJob({
          layerId: "edit_c",
          at: "2026-08-27T11:00:00.000Z",
          baseLayers: [base("edit_a", { opacity: 40, offset: { x: 12, y: -5 } }), base("edit_b")],
        }),
      ],
      "editdoc_1",
    );

    const byId = new Map(document?.layers.map((layer) => [layer.id, layer]));
    expect(byId.get("edit_a")).toMatchObject({ opacity: 40, offset: { x: 12, y: -5 } });
    expect(byId.get("edit_b")).toMatchObject({ opacity: 100, offset: { x: 0, y: 0 } });
    // The top layer was never anybody's base, so it has no record and defaults.
    expect(byId.get("edit_c")).toMatchObject({ opacity: 100 });
  });

  it("takes the stacking order the last generation froze, over creation order", () => {
    // edit_b was created second but dragged below edit_a before edit_c ran, and
    // edit_c's frozen base is the only place that reordering was ever recorded.
    const document = restoreEditDocument(
      [
        layerJob({ layerId: "edit_a", at: "2026-08-27T10:00:00.000Z" }),
        layerJob({ layerId: "edit_b", at: "2026-08-27T10:30:00.000Z" }),
        layerJob({ layerId: "edit_c", at: "2026-08-27T11:00:00.000Z", baseLayers: [base("edit_b"), base("edit_a")] }),
      ],
      "editdoc_1",
    );
    expect(document?.layers.map((layer) => layer.id)).toEqual(["edit_b", "edit_a", "edit_c"]);
    expect(document?.inferredOrder).toBe(false);
  });

  it("admits when the order had to be guessed", () => {
    // edit_b was hidden when edit_c ran, so nothing recorded where it sat.
    const document = restoreEditDocument(
      [
        layerJob({ layerId: "edit_a", at: "2026-08-27T10:00:00.000Z" }),
        layerJob({ layerId: "edit_b", at: "2026-08-27T10:30:00.000Z" }),
        layerJob({ layerId: "edit_c", at: "2026-08-27T11:00:00.000Z", baseLayers: [base("edit_a")] }),
      ],
      "editdoc_1",
    );
    expect(document?.inferredOrder).toBe(true);
    expect(document?.layers.map((layer) => layer.id)).toEqual(["edit_a", "edit_b", "edit_c"]);
  });

  it("names a layer by its prompt, trimmed at a word, and numbers a promptless one", () => {
    const document = restoreEditDocument(
      [
        layerJob({ layerId: "edit_a", at: "2026-08-27T10:00:00.000Z", prompt: "  replace   the sky  " }),
        layerJob({
          layerId: "edit_b",
          at: "2026-08-27T10:30:00.000Z",
          prompt: "remove the overhead cabling and the satellite dish from the roofline",
        }),
        layerJob({ layerId: "edit_9f3c", at: "2026-08-27T11:00:00.000Z", prompt: "   " }),
      ],
      "editdoc_1",
    );
    const names = document?.layers.map((layer) => layer.name);
    expect(names?.[0]).toBe("replace the sky");
    expect(names?.[1]).toBe("remove the overhead cabling and…");
    expect(names?.[2]).toBe("Edit 9f3c");
  });

  it("has nothing to reopen when only the flattened composite survives", () => {
    expect(restoreEditDocument([finalizedJob()], "editdoc_1")).toBeUndefined();
    expect(restoreEditDocument([layerJob({ layerId: "a", at: "2026-08-27T10:00:00.000Z" })], "editdoc_other")).toBeUndefined();
  });
});

describe("what a session has cost", () => {
  /** A completed run, priced the way production prices one. */
  function priced(layerId: string, at: string, extra: Partial<Job> = {}): Job {
    const job = layerJob({ layerId, at });
    return {
      ...job,
      creditsActual: 1,
      creditsActualSource: "pod_runtime",
      runpodTiming: { executionMs: 30000, gpuTypeId: "NVIDIA RTX PRO 6000", usdPerSecond: 0.0001844 },
      creditUsage: { total_estimated_credits: 17.32, total_estimated_usd: 0.0821, source: "credit_tracker:runtime_price" },
      ...extra,
    } as Job;
  }

  it("adds up every generation, including the takes that were replaced", () => {
    // Two layers, one of them regenerated: three runs were paid for, two survive.
    const cost = editSessionCost(
      [
        priced("edit_a", "2026-08-27T10:00:00.000Z"),
        priced("edit_b", "2026-08-27T10:30:00.000Z"),
        priced("edit_a", "2026-08-27T11:00:00.000Z"),
      ],
      "editdoc_1",
    );

    expect(cost.generations).toBe(3);
    expect(cost.layers).toBe(2);
    expect(cost.credits).toBeCloseTo(54.96, 2);
    expect(cost.usd).toBeCloseTo(0.262896, 5);
    expect(cost.unmeasured).toBe(0);
  });

  it("counts nothing from another document, or from a run still going", () => {
    const cost = editSessionCost(
      [
        priced("edit_a", "2026-08-27T10:00:00.000Z"),
        priced("edit_x", "2026-08-27T10:10:00.000Z", {
          workflowOptions: layerJob({ layerId: "edit_x", at: "x", documentId: "editdoc_other" }).workflowOptions,
        }),
        priced("edit_b", "2026-08-27T10:20:00.000Z", { status: "running" }),
        priced("edit_c", "2026-08-27T10:30:00.000Z", { status: "failed" }),
      ],
      "editdoc_1",
    );
    expect(cost.generations).toBe(1);
  });

  it("reports an unpriceable run separately rather than as free", () => {
    // No worker time reported, so there is no price -- counting it as zero would
    // make the session total look complete when it is a floor.
    const cost = editSessionCost(
      [
        priced("edit_a", "2026-08-27T10:00:00.000Z"),
        priced("edit_b", "2026-08-27T10:30:00.000Z", {
          runpodTiming: undefined,
          creditsActual: undefined,
          creditsActualSource: undefined,
        }),
      ],
      "editdoc_1",
    );
    expect(cost.generations).toBe(2);
    expect(cost.unmeasured).toBe(1);
    expect(cost.credits).toBeCloseTo(18.32, 2);
  });

  it("is empty for a document that has not generated anything, or none at all", () => {
    expect(editSessionCost([], "editdoc_1")).toMatchObject({ generations: 0, layers: 0, credits: 0, usd: 0 });
    expect(editSessionCost([priced("edit_a", "2026-08-27T10:00:00.000Z")], undefined)).toMatchObject({ generations: 0 });
  });
});
