export type CropSettings = {
  scale: number;
  offsetX: number;
  offsetY: number;
  aspectRatio: number;
  outputWidth?: number;
  outputHeight?: number;
};

export async function getImageSize(url: string): Promise<{ width: number; height: number }> {
  const image = await loadImage(url);
  return { width: image.naturalWidth, height: image.naturalHeight };
}

export function outputSizeForResolution(resolution: string, aspectRatio = 16 / 9) {
  const normalized = resolution.trim().toLowerCase();

  if (normalized === "auto") return { width: 1024, height: 1024 };
  if (normalized === "1k") return { width: 1024, height: 1024 };
  if (normalized === "2k") return { width: 2048, height: 2048 };
  if (normalized === "720p") return { width: 1280, height: 720 };
  if (normalized === "1080p") return { width: 1920, height: 1080 };
  if (normalized === "4k") return { width: 3840, height: 2160 };

  const match = normalized.match(/(\d+)\s*x\s*(\d+)/i);
  if (match) {
    return { width: Number(match[1]), height: Number(match[2]) };
  }

  const width = 1920;
  return { width, height: Math.round(width / aspectRatio) };
}

export function isNearAspectRatio(width: number | undefined, height: number | undefined, aspectRatio = 16 / 9, tolerance = 0.015) {
  if (!width || !height) return false;
  return Math.abs(width / height - aspectRatio) <= aspectRatio * tolerance;
}

export async function cropImageToDataUrl(
  url: string,
  settings: CropSettings,
): Promise<string> {
  const image = await loadImage(url);
  const width = settings.outputWidth ?? 1920;
  const height = settings.outputHeight ?? Math.round(width / settings.aspectRatio);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Canvas is not supported by this browser.");
  }

  canvas.width = width;
  canvas.height = height;

  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);

  const imageAspect = image.naturalWidth / image.naturalHeight;
  const coverScale = imageAspect > settings.aspectRatio
    ? height / image.naturalHeight
    : width / image.naturalWidth;
  const finalScale = coverScale * clamp(settings.scale, 1, 4);
  const drawWidth = image.naturalWidth * finalScale;
  const drawHeight = image.naturalHeight * finalScale;
  const maxOffsetX = Math.max(0, (drawWidth - width) / 2);
  const maxOffsetY = Math.max(0, (drawHeight - height) / 2);
  const drawX = (width - drawWidth) / 2 + clamp(settings.offsetX, -1, 1) * maxOffsetX;
  const drawY = (height - drawHeight) / 2 + clamp(settings.offsetY, -1, 1) * maxOffsetY;

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, drawX, drawY, drawWidth, drawHeight);

  return canvas.toDataURL("image/jpeg", 0.94);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load image."));
    image.src = url;
  });
}
