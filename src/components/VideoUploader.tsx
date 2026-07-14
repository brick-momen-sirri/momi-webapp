import { ChangeEvent, DragEvent, useRef, useState } from "react";
import { Film, Replace, Trash2, UploadCloud } from "lucide-react";
import type { UploadedVideo } from "../types";
import { createClientId } from "../utils/id";

type VideoUploaderProps = {
  video?: UploadedVideo;
  onChange: (video: UploadedVideo | undefined) => void;
};

export function VideoUploader({ video, onChange }: VideoUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  function applyFile(file: File) {
    const url = URL.createObjectURL(file);
    onChange({
      id: createClientId("vid_"),
      name: file.name,
      url,
      size: file.size,
    });
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      applyFile(file);
      event.target.value = "";
    }
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file && isVideoFile(file)) {
      applyFile(file);
    }
  }

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UploadCloud className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold">Input Video</h2>
        </div>
        <span className="rounded-full bg-teal-50 px-2 py-1 text-[11px] font-semibold text-teal-700">
          required
        </span>
      </div>

      {video ? (
        <div className="min-w-0 rounded-md border border-line bg-white p-2">
          <div className="relative aspect-video overflow-hidden rounded-md bg-stone-100">
            <video src={video.url} className="h-full w-full object-cover" controls preload="metadata" />
            <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-teal-100 px-2 py-1 text-[11px] font-semibold text-teal-800">
              ready
            </span>
          </div>
          <div className="mt-2 min-h-8">
            <p className="truncate text-xs font-semibold">Input video</p>
            <p className="truncate text-[11px] text-stone-500">{video.name}</p>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex h-8 items-center justify-center rounded-md border border-line text-stone-600 transition hover:bg-stone-50"
              title="Replace video"
            >
              <Replace className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="flex h-8 items-center justify-center rounded-md border border-line text-stone-600 transition hover:bg-red-50 hover:text-red-600"
              title="Remove video"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <input ref={inputRef} type="file" accept="video/*,.mp4,.mov,.webm,.mkv,.avi,.m4v" className="hidden" onChange={handleFileInput} />
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`flex h-32 w-full min-w-0 flex-col items-center justify-center rounded-md border border-dashed px-2 text-center transition ${
              isDragging ? "border-accent bg-accent/10" : "border-line bg-mist/60 hover:bg-white"
            }`}
          >
            <Film className="h-6 w-6 text-stone-400" />
            <span className="mt-2 text-xs font-semibold">Input video</span>
            <span className="mt-1 text-[11px] leading-4 text-stone-500">Drop video or browse</span>
          </button>
          <input ref={inputRef} type="file" accept="video/*,.mp4,.mov,.webm,.mkv,.avi,.m4v" className="hidden" onChange={handleFileInput} />
        </>
      )}
    </section>
  );
}

function isVideoFile(file: File) {
  return file.type.startsWith("video/") || /\.(avi|m4v|mkv|mov|mp4|webm)$/i.test(file.name);
}
