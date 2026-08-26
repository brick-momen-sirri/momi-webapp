import assert from "node:assert/strict";
import test from "node:test";

import { parseFinalizeStillImageEditRequest } from "./stillImageEditFinalization.js";

const valid = {
  projectId: "project_1",
  targetFolderId: "folder_1",
  documentId: "editdoc_1",
  originalSourceUrl: "/api/media?path=C%3A%5Cproject%5Coriginal.png",
  prompt: "Replace the car",
  saveNumber: "12",
  layers: [
    {
      layerId: "layer_1",
      crop: { x: 10, y: 20, size: 100, sourceWidth: 400, sourceHeight: 300 },
      generatedCropUrl: "/api/media?path=C%3A%5Cproject%5Ccrop.png",
      maskSourceUrl: "/api/media?path=C%3A%5Cproject%5Cmask.png",
    },
  ],
};

test("final composite requests preserve ordered layer assets and normalize the camera number", () => {
  const parsed = parseFinalizeStillImageEditRequest(valid);
  assert.equal(parsed.saveNumber, "0012");
  assert.deepEqual(parsed.layers, valid.layers);
});

test("final composite requests require at least one visible generated layer", () => {
  assert.throws(() => parseFinalizeStillImageEditRequest({ ...valid, layers: [] }), /at least one visible edit layer/i);
});

test("final composite requests reject crops outside the source", () => {
  assert.throws(
    () =>
      parseFinalizeStillImageEditRequest({
        ...valid,
        layers: [{ ...valid.layers[0], crop: { x: 350, y: 20, size: 100, sourceWidth: 400, sourceHeight: 300 } }],
      }),
    /outside the source image/i,
  );
});
