// The mask, as the settings rail shows it.
//
// A thumbnail with the painted region washed over, and a button that opens the
// editor. The rail is too narrow to paint in, but it is where the artist decides
// whether to generate, and "is a region chosen, and is it the right one" is a
// question a thumbnail answers.

import { Brush, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { editCropHeight, editCropWidth, type EditLayerCompositeDescriptor } from "../features/still-images/imageEditLayers";
import { hasPaintedRegion, type MaskDrawing } from "../features/still-images/maskDrawing";
import {
  loadImageElement,
  maskImageToAlphaCanvas,
  renderEditCompositePreview,
  renderOverlayCanvas,
} from "../features/still-images/maskRaster";
import { exportLayeredPsd } from "../features/still-images/psdExport";
import type { StillImageEditLayer } from "../features/still-images/stillImageCategories";
import { resolveMediaUrl } from "../services/api/mediaAccess";
import type { UploadedImage } from "../types";
import { MaskEditorDialog, type EditorLayerContext } from "./MaskEditorDialog";

type MaskRegionFieldProps = {
  image?: UploadedImage;
  /** Every visible layer, for the always-current composite thumbnail. */
  layers?: EditLayerCompositeDescriptor[];
  /** Frozen generation base shown behind the mask in the full editor. */
  editorLayers?: EditLayerCompositeDescriptor[];
  /** Complete layer stack, including hidden layers, for Photoshop export. */
  exportLayers?: StillImageEditLayer[];
  drawing?: MaskDrawing;
  onChange: (drawing: MaskDrawing | undefined) => void;
  /** Incremented only by an upload/drop, so ordinary rerenders do not reopen it. */
  openRequest?: number;
  editorKey?: string;
  leftPanel?: ReactNode;
  floatingPanel?: ReactNode;
  onEditorDraftChange?: (drawing: MaskDrawing) => void;
  onFinish?: (drawing: MaskDrawing) => boolean | void | Promise<boolean | void>;
  finishing?: boolean;
  processing?: boolean;
  processingLabel?: string;
  /** The selected layer, so the editor can say and change what it acts on. */
  layerContext?: EditorLayerContext;
};

type DecodedSource = { url: string; element?: HTMLImageElement; failed?: boolean };
type CompositePreview = { key: string; source: HTMLImageElement; canvas: HTMLCanvasElement };

export function MaskRegionField({
  image,
  layers = [],
  editorLayers = layers,
  exportLayers = [],
  drawing,
  onChange,
  openRequest = 0,
  editorKey,
  leftPanel,
  floatingPanel,
  onEditorDraftChange,
  onFinish,
  finishing = false,
  processing = false,
  processingLabel,
  layerContext,
}: MaskRegionFieldProps) {
  // Stamped with the URL it came from and read back through it, rather than being
  // cleared when the source changes. Clearing would mean writing state during the
  // render pass that noticed the change; this way the stale result is simply not
  // the one that matches, and the only writes happen when a decode finishes.
  const [decoded, setDecoded] = useState<DecodedSource | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [exportingPsd, setExportingPsd] = useState(false);
  const [psdExportError, setPsdExportError] = useState<string | undefined>(undefined);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const openedRequestRef = useRef(0);

  // The preview and the editor both need the decoded bitmap, and decoding a 4K PNG
  // is not something to do twice or to do while an overlay is opening.
  const sourceUrl = image?.croppedUrl ?? image?.url;
  const current = decoded && decoded.url === sourceUrl ? decoded : undefined;
  const element = current?.element;
  const failed = current?.failed === true;
  const layerKey = compositeDescriptorKey(layers);
  const editorLayerKey = compositeDescriptorKey(editorLayers);
  // Keep enough detail for zooming in the full-screen editor. The rail preview
  // is drawn down from this canvas, so the composite is still built only once.
  const currentComposite = useLayerComposite(element, layers, 4096);
  const previewSource: CanvasImageSource | undefined = currentComposite ?? element;
  const separateEditorLayers = useMemo(
    () => (editorLayerKey === layerKey ? [] : editorLayers),
    [editorLayerKey, editorLayers, layerKey],
  );
  const frozenEditorComposite = useLayerComposite(element, separateEditorLayers, 4096);
  const editorSource: CanvasImageSource | undefined =
    editorLayerKey === layerKey ? (currentComposite ?? element) : (frozenEditorComposite ?? element);

  useEffect(() => {
    if (!sourceUrl) return;

    let live = true;
    loadImageElement(sourceUrl).then(
      (loaded) => {
        if (live) setDecoded({ url: sourceUrl, element: loaded });
      },
      () => {
        if (live) setDecoded({ url: sourceUrl, failed: true });
      },
    );
    return () => {
      live = false;
    };
  }, [sourceUrl]);

  useEffect(() => {
    if (!element || openRequest <= openedRequestRef.current) return;
    openedRequestRef.current = openRequest;
    setEditing(true);
  }, [element, openRequest]);

  // Strokes are in the source's pixels, so a new source invalidates them. Doing
  // this here rather than in the editor means the panel never counts a stale mask
  // as a region chosen.
  useEffect(() => {
    if (!element || !drawing) return;
    const width = element.naturalWidth || element.width;
    const height = element.naturalHeight || element.height;
    if (drawing.width !== width || drawing.height !== height) onChange(undefined);
  }, [drawing, element, onChange]);

  const overlay = useMemo(() => (hasPaintedRegion(drawing) ? renderOverlayCanvas(drawing as MaskDrawing) : undefined), [drawing]);

  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas || !element || !previewSource) return;

    const width = element.naturalWidth || element.width;
    const height = element.naturalHeight || element.height;
    const scale = Math.min(1, 320 / Math.max(1, width));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(previewSource, 0, 0, canvas.width, canvas.height);
    if (overlay) context.drawImage(overlay, 0, 0, canvas.width, canvas.height);
  }, [element, overlay, previewSource]);

  const regionSelected = hasPaintedRegion(drawing);
  const psdExportAvailable = exportLayers.some((layer) => Boolean(layer.generatedCropUrl ?? layer.generatedCropSourceUrl));

  async function handleExportPsd() {
    if (!element || exportingPsd || !psdExportAvailable) return;
    setExportingPsd(true);
    setPsdExportError(undefined);
    try {
      await exportLayeredPsd({
        source: element,
        width: element.naturalWidth || element.width,
        height: element.naturalHeight || element.height,
        imageName: image?.name ?? "edited-composite.png",
        layers: exportLayers,
      });
    } catch (error) {
      setPsdExportError(error instanceof Error ? error.message : "Could not export the layered PSD.");
    } finally {
      setExportingPsd(false);
    }
  }

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <div className="mb-3 flex items-center gap-2">
        <Brush className="h-4 w-4 text-stone-500" />
        <h2 className="text-sm font-semibold">Current composite &amp; region</h2>
      </div>

      {!image ? (
        <p className="rounded-md bg-mist px-3 py-2 text-xs leading-5 text-stone-600">
          Upload a source image above, then paint or select the part you want changed.
        </p>
      ) : failed ? (
        <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          That image could not be opened for painting. Try uploading it again.
        </p>
      ) : (
        <>
          <div className="overflow-hidden rounded-md border border-line bg-stone-100">
            <canvas ref={previewRef} className="block h-auto w-full" aria-label="The selected edit region on the source image" />
          </div>

          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={!element || processing}
              className="flex h-9 flex-1 items-center justify-center gap-2 rounded-md bg-ink px-3 text-xs font-bold text-white transition hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Brush className="h-3.5 w-3.5" />
              {regionSelected ? "Edit region" : "Choose region"}
            </button>
            {regionSelected ? (
              <button
                type="button"
                onClick={() => onChange(undefined)}
                disabled={processing}
                aria-label="Clear the edit region"
                title="Clear the edit region"
                className="flex h-9 w-9 items-center justify-center rounded-md border border-line text-stone-500 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          <p className="mt-2 text-xs leading-5 text-stone-500">
            {regionSelected
              ? "Only the selected area is re-rendered. Everything outside it is kept from the original."
              : "Nothing is selected yet. Paint a mask or draw a rectangle in the editor."}
          </p>
        </>
      )}

      {editing && element && editorSource ? (
        <MaskEditorDialog
          key={editorKey}
          image={editorSource}
          imageWidth={element.naturalWidth || element.width}
          imageHeight={element.naturalHeight || element.height}
          imageName={image?.name ?? "the source image"}
          drawing={drawing}
          onDraftChange={onEditorDraftChange}
          leftPanel={leftPanel}
          floatingPanel={floatingPanel}
          finishing={finishing}
          readOnly={processing}
          processing={processing}
          processingLabel={processingLabel}
          layerContext={layerContext}
          onExportPsd={handleExportPsd}
          psdExportAvailable={psdExportAvailable}
          exportingPsd={exportingPsd}
          psdExportError={psdExportError}
          closeLabel="Close"
          onApply={(next) => {
            setEditing(false);
            onChange(hasPaintedRegion(next) ? next : undefined);
          }}
          onFinish={
            onFinish
              ? (next) => {
                  onChange(hasPaintedRegion(next) ? next : undefined);
                  void Promise.resolve(onFinish(next)).then((close) => {
                    if (close !== false) setEditing(false);
                  });
                }
              : undefined
          }
          onClose={() => setEditing(false)}
        />
      ) : null}
    </section>
  );
}

function useLayerComposite(element: HTMLImageElement | undefined, layers: EditLayerCompositeDescriptor[], maximumSide: number) {
  const [composite, setComposite] = useState<CompositePreview | undefined>(undefined);
  const descriptorKey = compositeDescriptorKey(layers);
  const key = descriptorKey ? `${maximumSide}:${descriptorKey}` : "";
  const layersRef = useRef(layers);

  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  useEffect(() => {
    if (!element || !key) return;
    let live = true;
    Promise.allSettled(layersRef.current.map(loadCompositeLayer)).then((settled) => {
      if (!live) return;
      const sources = settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
      const width = element.naturalWidth || element.width;
      const height = element.naturalHeight || element.height;
      setComposite({ key, source: element, canvas: renderEditCompositePreview(element, width, height, sources, maximumSide) });
    });
    return () => {
      live = false;
    };
  }, [element, key, maximumSide]);

  // Hold the previous composite while a newly completed layer is decoded. Showing
  // the prior frame for a moment produces a stable transition; falling back to the
  // original would flash every existing edit off and back on.
  if (!key || !composite || composite.source !== element) return undefined;
  return composite.canvas;
}

/**
 * Decoded layer bitmaps, kept for the life of the tab.
 *
 * Opacity is a slider: dragging it rebuilds the composite on every frame, and
 * each rebuild used to re-decode every layer's PNG. The bytes are already in the
 * browser cache, but the decode is not free and it is the same handful of small
 * crops every time. Keyed by URL, which is content-addressed here -- a
 * regenerated layer gets a new one rather than replacing what a URL points at.
 *
 * Bounded, because that same content-addressing means the keys only ever grow: a
 * long session of regenerations would otherwise hold every take it had ever
 * shown. Oldest out first, which is the take least likely to still be on screen.
 */
const DECODED_LAYER_LIMIT = 64;
const decodedLayerImages = new Map<string, Promise<HTMLImageElement>>();

function decodeLayerImage(url: string) {
  const cached = decodedLayerImages.get(url);
  if (cached) {
    // Refresh its position so the layers currently in the composite are the last
    // ones to be dropped.
    decodedLayerImages.delete(url);
    decodedLayerImages.set(url, cached);
    return cached;
  }
  const decoding = loadImageElement(url).catch((error) => {
    decodedLayerImages.delete(url);
    throw error;
  });
  decodedLayerImages.set(url, decoding);
  while (decodedLayerImages.size > DECODED_LAYER_LIMIT) {
    const oldest = decodedLayerImages.keys().next();
    if (oldest.done) break;
    decodedLayerImages.delete(oldest.value);
  }
  return decoding;
}

async function loadCompositeLayer(layer: EditLayerCompositeDescriptor) {
  const image = await decodeLayerImage(layer.generatedCropUrl ?? resolveMediaUrl(layer.generatedCropSourceUrl));
  const placement = {
    crop: layer.crop,
    opacity: layer.opacity,
    offset: layer.offset,
    maskOffset: layer.maskOffset,
    maskEnabled: layer.maskEnabled,
  };
  if (layer.mask) return { image, ...placement, drawing: layer.mask };
  if (layer.maskSourceUrl) {
    const mask = await decodeLayerImage(resolveMediaUrl(layer.maskSourceUrl));
    return {
      image,
      ...placement,
      mask: maskImageToAlphaCanvas(mask, editCropWidth(layer.crop), editCropHeight(layer.crop)),
    };
  }
  throw new Error(`Layer ${layer.layerId} has no mask source.`);
}

/**
 * Everything that changes what the composite looks like, as one string.
 *
 * The composite is rebuilt when this changes and only when it changes, so
 * anything the artist can adjust live -- opacity, a move, the mask switch -- has
 * to appear here or the canvas quietly keeps showing the previous state.
 */
function compositeDescriptorKey(layers: EditLayerCompositeDescriptor[]) {
  return layers
    .map((layer) =>
      [
        layer.layerId,
        layer.generatedCropSourceUrl,
        layer.maskSourceUrl ?? "drawing",
        layer.revision ?? 0,
        layer.opacity ?? 100,
        `${layer.offset?.x ?? 0},${layer.offset?.y ?? 0}`,
        `${layer.maskOffset?.x ?? 0},${layer.maskOffset?.y ?? 0}`,
        layer.maskEnabled === false ? "nomask" : "mask",
      ].join(":"),
    )
    .join("|");
}
