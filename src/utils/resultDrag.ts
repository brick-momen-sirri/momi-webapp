export const RESULT_IMAGE_DRAG_MIME = "application/x-momi-result-image";

export type ResultImageDragData = {
  url: string;
  name?: string;
  jobId?: string;
  modelType?: string;
};

export function setResultImageDragData(dataTransfer: DataTransfer, data: ResultImageDragData) {
  const payload: ResultImageDragData = {
    ...data,
    name: data.name || fileNameFromUrl(data.url) || "result-image",
  };

  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(RESULT_IMAGE_DRAG_MIME, JSON.stringify(payload));
  dataTransfer.setData("text/uri-list", data.url);
  dataTransfer.setData("text/plain", data.url);
}

export function getResultImageDragData(dataTransfer: DataTransfer): ResultImageDragData | null {
  if (!hasResultImageDragData(dataTransfer)) {
    return null;
  }

  try {
    const parsed = JSON.parse(dataTransfer.getData(RESULT_IMAGE_DRAG_MIME)) as Partial<ResultImageDragData>;
    if (typeof parsed.url === "string" && parsed.url.trim()) {
      return {
        url: parsed.url,
        name: typeof parsed.name === "string" ? parsed.name : undefined,
        jobId: typeof parsed.jobId === "string" ? parsed.jobId : undefined,
        modelType: typeof parsed.modelType === "string" ? parsed.modelType : undefined,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export function hasResultImageDragData(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes(RESULT_IMAGE_DRAG_MIME);
}

function fileNameFromUrl(url: string) {
  try {
    const path = new URL(url, window.location.href).pathname;
    return decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "");
  } catch {
    return "";
  }
}
