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
  assert.deepEqual(parsed.layers, [
    {
      ...valid.layers[0],
      crop: { ...valid.layers[0].crop, width: 100, height: 100 },
    },
  ]);
});

test("final composite requests preserve rectangular crops", () => {
  const crop = { x: 10, y: 20, size: 160, width: 160, height: 90, sourceWidth: 400, sourceHeight: 300 };
  const parsed = parseFinalizeStillImageEditRequest({
    ...valid,
    layers: [{ ...valid.layers[0], crop }],
  });
  assert.deepEqual(parsed.layers[0].crop, crop);
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

test("final composite requests carry layer opacity, feather and displacement, and drop the defaults", () => {
  const parsed = parseFinalizeStillImageEditRequest({
    ...valid,
    layers: [{ ...valid.layers[0], opacity: 40, maskFeather: 16, offset: { x: -25, y: 12 } }],
  });
  assert.equal(parsed.layers[0].opacity, 40);
  assert.equal(parsed.layers[0].maskFeather, 16);
  assert.deepEqual(parsed.layers[0].offset, { x: -25, y: 12 });

  // A layer at its generated position and full strength adds nothing to the wire.
  const plain = parseFinalizeStillImageEditRequest({
    ...valid,
    layers: [{ ...valid.layers[0], opacity: 100, maskFeather: 0, offset: { x: 0, y: 0 } }],
  });
  assert.equal(plain.layers[0].opacity, undefined);
  assert.equal(plain.layers[0].maskFeather, undefined);
  assert.equal(plain.layers[0].offset, undefined);
});

test("final composite requests reject an out-of-range opacity or displacement", () => {
  assert.throws(
    () => parseFinalizeStillImageEditRequest({ ...valid, layers: [{ ...valid.layers[0], maskFeather: 1_001 }] }),
    /mask feather is invalid/i,
  );
  assert.throws(
    () => parseFinalizeStillImageEditRequest({ ...valid, layers: [{ ...valid.layers[0], opacity: 140 }] }),
    /opacity is invalid/i,
  );
  assert.throws(
    () => parseFinalizeStillImageEditRequest({ ...valid, layers: [{ ...valid.layers[0], offset: { x: 9_000, y: 0 } }] }),
    /offset x is invalid/i,
  );
  assert.throws(
    () => parseFinalizeStillImageEditRequest({ ...valid, layers: [{ ...valid.layers[0], offset: { x: 1.5, y: 0 } }] }),
    /offset x is invalid/i,
  );
});
