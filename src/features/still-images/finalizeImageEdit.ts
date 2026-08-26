import { finalizeBackendStillImageEdit, uploadBackendMedia } from "../../services/backendApi";
import type { Job } from "../../types";
import { createClientId } from "../../utils/id";
import { uploadJobMediaUrl } from "../generation/generationUtils";
import { drawingForCrop, visibleEditLayers } from "./imageEditLayers";
import type { MaskDrawing } from "./maskDrawing";
import { canvasToPngFile, renderMaskCanvas } from "./maskRaster";
import type { StillImageCategoryState } from "./stillImageCategories";

/** Turn the visible non-destructive layer stack into one durable Results card. */
export async function finalizeImageEdit(input: {
  projectId: string;
  targetFolderId: string;
  saveNumber: string;
  state: StillImageCategoryState;
  currentDrawing: MaskDrawing;
}): Promise<Job> {
  const source = input.state.images[0];
  if (!source) throw new Error("The editor no longer has its source image.");
  if (
    input.state.editLayers?.some(
      (layer) => layer.visible && (layer.status === "queued" || layer.status === "sending" || layer.status === "running"),
    )
  ) {
    throw new Error("Wait for the visible edit layers to finish before completing the composite.");
  }

  const descriptors = visibleEditLayers(input.state).map((layer) =>
    layer.layerId === input.state.activeEditLayerId ? { ...layer, mask: input.currentDrawing } : layer,
  );
  if (!descriptors.length) throw new Error("Generate at least one visible edit layer before finishing.");

  const originalSourceUrl =
    input.state.editOriginalSourceUrl ??
    input.state.editLayers?.find((layer) => layer.originalSourceUrl)?.originalSourceUrl ??
    (await uploadJobMediaUrl(source.croppedUrl ?? source.url, {
      projectId: input.projectId,
      kind: "image",
      name: source.name,
    }));

  const layers = await Promise.all(
    descriptors.map(async (layer) => {
      let maskSourceUrl = layer.maskSourceUrl;
      if (layer.mask) {
        const maskFile = await canvasToPngFile(
          renderMaskCanvas(drawingForCrop(layer.mask, layer.crop)),
          `${layer.layerId}-final-mask.png`,
        );
        maskSourceUrl = await uploadBackendMedia(maskFile, {
          projectId: input.projectId,
          kind: "image",
          name: maskFile.name,
        });
      }
      if (!maskSourceUrl) throw new Error(`Layer ${layer.layerId} is missing its mask.`);
      return {
        layerId: layer.layerId,
        crop: layer.crop,
        generatedCropUrl: layer.generatedCropSourceUrl,
        maskSourceUrl,
      };
    }),
  );

  return finalizeBackendStillImageEdit({
    projectId: input.projectId,
    targetFolderId: input.targetFolderId || null,
    documentId:
      input.state.editDocumentId ??
      input.state.editLayers?.find((layer) => layer.documentId)?.documentId ??
      createClientId("editdoc_"),
    originalSourceUrl,
    prompt: input.state.prompt.trim(),
    saveNumber: input.saveNumber,
    layers,
  });
}
