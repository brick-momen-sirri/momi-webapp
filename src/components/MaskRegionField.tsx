// The mask, as the settings rail shows it.
//
// A thumbnail with the painted region washed over, and a button that opens the
// editor. The rail is too narrow to paint in, but it is where the artist decides
// whether to generate, and "is a region chosen, and is it the right one" is a
// question a thumbnail answers.

import { Brush, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { EditLayerCompositeDescriptor } from "../features/still-images/imageEditLayers";
import type { MaskDrawing } from "../features/still-images/maskDrawing";
import {
  loadImageElement,
  maskImageToAlphaCanvas,
  renderEditCompositePreview,
  renderOverlayCanvas,
} from "../features/still-images/maskRaster";
import { resolveMediaUrl } from "../services/api/mediaAccess";
import type { UploadedImage } from "../types";
import { MaskEditorDialog } from "./MaskEditorDialog";

type MaskRegionFieldProps = {
  image?: UploadedImage;
  /** Every visible layer, for the always-current composite thumbnail. */
  layers?: EditLayerCompositeDescriptor[];
  /** Frozen generation base shown behind the mask in the full editor. */
  editorLayers?: EditLayerCompositeDescriptor[];
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
};

type DecodedSource = { url: string; element?: HTMLImageElement; failed?: boolean };
type CompositePreview = { key: string; source: HTMLImageElement; canvas: HTMLCanvasElement };

export function MaskRegionField({
  image,
  layers = [],
  editorLayers = layers,
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
}: MaskRegionFieldProps) {
  // Stamped with the URL it came from and read back through it, rather than being
  // cleared when the source changes. Clearing would mean writing state during the
  // render pass that noticed the change; this way the stale result is simply not
  // the one that matches, and the only writes happen when a decode finishes.
  const [decoded, setDecoded] = useState<DecodedSource | undefined>(undefined);
  const [editing, setEditing] = useState(false);
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

  const overlay = useMemo(() => (drawing?.strokes.length ? renderOverlayCanvas(drawing) : undefined), [drawing]);

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

  const painted = Boolean(drawing?.strokes.length);

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <div className="mb-3 flex items-center gap-2">
        <Brush className="h-4 w-4 text-stone-500" />
        <h2 className="text-sm font-semibold">Current composite &amp; mask</h2>
      </div>

      {!image ? (
        <p className="rounded-md bg-mist px-3 py-2 text-xs leading-5 text-stone-600">
          Upload a source image above, then paint the part of it you want changed.
        </p>
      ) : failed ? (
        <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          That image could not be opened for painting. Try uploading it again.
        </p>
      ) : (
        <>
          <div className="overflow-hidden rounded-md border border-line bg-stone-100">
            <canvas ref={previewRef} className="block h-auto w-full" aria-label="The painted region on the source image" />
          </div>

          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={!element || processing}
              className="flex h-9 flex-1 items-center justify-center gap-2 rounded-md bg-ink px-3 text-xs font-bold text-white transition hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Brush className="h-3.5 w-3.5" />
              {painted ? "Edit region" : "Paint region"}
            </button>
            {painted ? (
              <button
                type="button"
                onClick={() => onChange(undefined)}
                disabled={processing}
                aria-label="Clear the painted region"
                title="Clear the painted region"
                className="flex h-9 w-9 items-center justify-center rounded-md border border-line text-stone-500 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          <p className="mt-2 text-xs leading-5 text-stone-500">
            {painted
              ? "Only the washed area is re-rendered. Everything outside it is kept from the original."
              : "Nothing is painted yet, so there is no region to edit."}
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
          closeLabel="Close"
          onApply={(next) => {
            setEditing(false);
            onChange(next.strokes.length ? next : undefined);
          }}
          onFinish={
            onFinish
              ? (next) => {
                  onChange(next.strokes.length ? next : undefined);
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

async function loadCompositeLayer(layer: EditLayerCompositeDescriptor) {
  const image = await loadImageElement(layer.generatedCropUrl ?? resolveMediaUrl(layer.generatedCropSourceUrl));
  if (layer.mask) return { image, crop: layer.crop, drawing: layer.mask };
  if (layer.maskSourceUrl) {
    const mask = await loadImageElement(resolveMediaUrl(layer.maskSourceUrl));
    return { image, crop: layer.crop, mask: maskImageToAlphaCanvas(mask, layer.crop.size, layer.crop.size) };
  }
  throw new Error(`Layer ${layer.layerId} has no mask source.`);
}

function compositeDescriptorKey(layers: EditLayerCompositeDescriptor[]) {
  return layers
    .map((layer) => `${layer.layerId}:${layer.generatedCropSourceUrl}:${layer.maskSourceUrl ?? "drawing"}:${layer.revision ?? 0}`)
    .join("|");
}
