import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Download,
  Folder,
  Hash,
  ImageIcon,
  Images,
  Loader2,
  Maximize2,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import type { StillImageCategoryDefinition, StillImageCategoryState } from "../features/still-images/stillImageCategories";
import { STILL_IMAGE_CATEGORIES } from "../features/still-images/stillImageCategories";
import { stillImageResultFileName } from "../features/still-images/resultFileName";
import { useNearViewport } from "../features/jobs/useNearViewport";
import { backendResultFileUrl, THUMBNAIL_WIDTH, thumbnailMediaUrl } from "../services/backendApi";
import type { Job, Project, User } from "../types";
import { cn } from "../utils/classNames";
import { FullscreenImagePreview, type FullscreenImage } from "./FullscreenImagePreview";

type StillImagesWorkspaceProps = {
  category: StillImageCategoryDefinition;
  state: StillImageCategoryState;
  selectedProject?: Project;
  targetFolderId: string;
  saveNumber: string;
  userName: string;
  /** Still image jobs only -- App filters by section before passing them here. */
  jobs: Job[];
  users?: User[];
};

export function StillImagesWorkspace({
  category,
  state,
  selectedProject,
  targetFolderId,
  saveNumber,
  userName,
  jobs,
  users = [],
}: StillImagesWorkspaceProps) {
  const CategoryIcon = category.icon;
  const targetFolder = selectedProject?.folders?.find((folder) => folder.folderId === targetFolderId && !folder.archived);

  return (
    <div className="middle-panel pb-3">
      <section className="jobs-header sticky top-0 z-30 mb-3 rounded-lg border border-line bg-white p-3 shadow-panel">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold">Still image results</h1>
            <span className="rounded-full bg-teal-50 px-2 py-1 text-xs font-semibold text-teal-700">
              {selectedProject?.name ?? "Select project"}
            </span>
            {targetFolder ? (
              <span className="rounded-full bg-cyan-50 px-2 py-1 text-xs font-semibold text-cyan-700">{targetFolder.name}</span>
            ) : null}
            <span className="text-sm font-semibold text-stone-500">
              {jobs.length} generated result{jobs.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      </section>

      {jobs.length ? (
        <div className="space-y-3">
          {jobs.map((job) => (
            <StillImageJobCard
              key={job.id}
              job={job}
              project={selectedProject}
              userName={users.find((user) => user.id === job.userId)?.name ?? userName}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          category={category}
          state={state}
          selectedProject={selectedProject}
          targetFolder={targetFolder?.name}
          saveNumber={saveNumber}
          icon={<CategoryIcon className="h-5 w-5" />}
        />
      )}
    </div>
  );
}

function StillImageJobCard({ job, project, userName }: { job: Job; project?: Project; userName: string }) {
  const preset = STILL_IMAGE_CATEGORIES.find((entry) => entry.id === job.workflowOptions?.stillImage?.categoryId);
  const PresetIcon = preset?.icon ?? ImageIcon;
  const resultUrl = job.resultUrl ?? job.thumbnailUrl;
  const inputImages = job.inputImages.filter(Boolean);
  const saveNumber = job.workflowOptions?.save?.cameraNumber ?? "0000";
  const qwenMode = job.workflowOptions?.stillImage?.settings?.mode;

  return (
    <article className="job-card-cv rounded-lg border border-line bg-white p-4 shadow-card">
      <div className="flex flex-col gap-3 border-b border-line pb-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={job.status} />
            <h2 className="text-sm font-bold">{job.modelType}</h2>
            {qwenMode ? (
              <span className="rounded-full bg-cyan-50 px-2 py-1 text-[11px] font-semibold text-cyan-700">
                {String(qwenMode)}
              </span>
            ) : null}
            <span className="rounded-full bg-stone-100 px-2 py-1 text-[11px] font-semibold text-stone-600">
              {project?.name ?? job.projectId}
            </span>
            {job.folderName ? (
              <span className="rounded-full bg-cyan-50 px-2 py-1 text-[11px] font-semibold text-cyan-700">{job.folderName}</span>
            ) : null}
            <span className="inline-flex items-center gap-1 rounded-full bg-cyan-50 px-2 py-1 text-[11px] font-semibold text-cyan-700">
              <Hash className="h-3 w-3" />
              Camera {saveNumber}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-stone-500">
            <span className="flex items-center gap-1">
              <UserRound className="h-3.5 w-3.5" />
              {userName}
            </span>
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {formatTimestamp(job.createdAt)}
            </span>
          </div>
        </div>
      </div>

      <div className="py-4">
        <section className="input-section rounded-lg border border-line bg-white/60 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-stone-500">
            <Images className="h-3.5 w-3.5" />
            Input preview
          </div>
          <div className="flex flex-wrap gap-3">
            {inputImages.length ? (
              <div className="flex flex-wrap gap-2">
                {inputImages.map((url, index) => (
                  <div key={url} className="relative h-20 w-32 overflow-hidden rounded-md border border-line bg-stone-100">
                    <img
                      src={thumbnailMediaUrl(url, THUMBNAIL_WIDTH.chip)}
                      alt={`Still image input ${index + 1}`}
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                    {inputImages.length > 1 ? (
                      <span className="absolute left-1.5 top-1.5 rounded-full bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold">
                        Input {index + 1}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex h-20 w-32 items-center justify-center rounded-md border border-dashed border-line bg-mist/70 px-2 text-center text-xs font-semibold text-stone-500">
                No input media
              </div>
            )}

            <div className="min-w-[260px] flex-1">
              {job.fileName ? <p className="mb-1 font-mono text-xs text-stone-500">{job.fileName}</p> : null}
              <p className="text-sm leading-6 text-stone-800">{job.prompt?.trim() || "No prompt for this preset."}</p>
            </div>
          </div>
        </section>

        <section className="result-section mt-4 flex justify-center">
          {resultUrl && job.status === "completed" ? (
            <StillImageResult job={job} url={resultUrl} />
          ) : (
            <div className="flex min-h-72 w-full max-w-5xl flex-col items-center justify-center rounded-lg border border-dashed border-line bg-mist/60 px-6 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full border border-line bg-white text-stone-400 shadow-sm">
                {job.status === "failed" || job.status === "canceled" ? (
                  <AlertTriangle className="h-5 w-5" />
                ) : (
                  <PresetIcon className="h-5 w-5" />
                )}
              </span>
              <p className="mt-3 text-sm font-semibold">{resultPlaceholderTitle(job.status)}</p>
              {job.errorMessage ? (
                <p className="mt-1 max-w-md text-xs leading-5 text-rose-700">{job.errorMessage}</p>
              ) : (
                <p className="mt-1 max-w-md text-xs leading-5 text-stone-500">
                  This preset renders on its own pod. Results appear here as soon as the worker returns them.
                </p>
              )}
            </div>
          )}
        </section>
      </div>

      <div className="grid gap-2 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <MetadataItem label="Status" value={job.status} />
        <MetadataItem label="Workflow" value={job.modelType} />
        <MetadataItem label="Input" value={`${inputImages.length} image${inputImages.length === 1 ? "" : "s"}`} />
        <MetadataItem label="Camera" value={saveNumber} />
        <MetadataItem label="Project" value={project?.shortName ?? "Not selected"} />
        <MetadataItem label="Folder" value={job.folderName ?? "Root"} />
      </div>
    </article>
  );
}

/**
 * A completed still image result.
 *
 * Still image outputs are the largest media this app handles -- 4K to 10K PNGs
 * that routinely pass 100 MB. Nothing here ever loads one. The card shows a grid
 * rendition, Open preview shows a fullscreen rendition, and only Download
 * touches the original, streamed straight from the backend as an attachment so
 * the bytes never enter this tab's memory.
 *
 * The image is not even requested until the card is near the viewport, so a
 * project with 50 results costs one small request per card the user actually
 * scrolls to rather than 50 originals up front.
 */
function StillImageResult({ job, url }: { job: Job; url: string }) {
  const [containerRef, inView] = useNearViewport<HTMLDivElement>();
  const [fullscreenImage, setFullscreenImage] = useState<FullscreenImage | null>(null);
  const name = job.fileName ?? `${job.modelType} result`;

  return (
    <div ref={containerRef} className="w-full">
      <div className="relative flex justify-center">
        {inView ? (
          <img
            src={thumbnailMediaUrl(url, THUMBNAIL_WIDTH.grid)}
            alt={`Result for ${job.modelType}`}
            loading="lazy"
            decoding="async"
            className="max-h-[32rem] w-auto max-w-full rounded-lg border border-line bg-stone-100 object-contain"
          />
        ) : (
          <div className="flex h-72 w-full max-w-5xl items-center justify-center rounded-lg border border-line bg-stone-100">
            <span className="rounded-full bg-white px-3 py-2 text-xs font-semibold text-stone-500 shadow-card">
              Result preview
            </span>
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={() =>
            setFullscreenImage({
              previewUrl: thumbnailMediaUrl(url, THUMBNAIL_WIDTH.fullscreen),
              name,
              downloadUrl: backendResultFileUrl(job.id, 0),
            })
          }
          className="flex items-center gap-1.5 rounded-md border border-line bg-white px-3 py-1.5 text-xs font-bold text-ink shadow-card transition hover:border-accent hover:bg-cyan-50/50"
        >
          <Maximize2 className="h-3.5 w-3.5" />
          Open preview
        </button>
        {/* A plain link, not a fetch: the backend already answers this with
            Content-Disposition: attachment, so the browser streams it to disk
            without the page ever holding the bytes. */}
        <a
          href={backendResultFileUrl(job.id, 0)}
          download
          className="flex items-center gap-1.5 rounded-md border border-line bg-white px-3 py-1.5 text-xs font-bold text-ink shadow-card transition hover:border-accent hover:bg-cyan-50/50"
          title="Download the untouched full-resolution original"
        >
          <Download className="h-3.5 w-3.5" />
          Download original
        </a>
      </div>

      {fullscreenImage ? (
        <FullscreenImagePreview image={fullscreenImage} onClose={() => setFullscreenImage(null)} />
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: Job["status"] }) {
  const running = status === "queued" || status === "sending" || status === "running";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold capitalize",
        status === "completed"
          ? "bg-teal-50 text-teal-700"
          : status === "failed" || status === "canceled"
            ? "bg-rose-50 text-rose-700"
            : "bg-amber-50 text-amber-800",
      )}
    >
      {status === "completed" ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : running ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <AlertTriangle className="h-3 w-3" />
      )}
      {status}
    </span>
  );
}

function EmptyState({
  category,
  state,
  selectedProject,
  targetFolder,
  saveNumber,
  icon,
}: {
  category: StillImageCategoryDefinition;
  state: StillImageCategoryState;
  selectedProject?: Project;
  targetFolder?: string;
  saveNumber: string;
  icon: React.ReactNode;
}) {
  const uploadedImages = state.images.filter(Boolean);

  return (
    <div className="space-y-3">
      <article className="job-card-cv rounded-lg border border-dashed border-line bg-white p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-line pb-3">
          <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-1 text-[11px] font-bold text-stone-700">
            Not submitted
          </span>
          <h2 className="text-sm font-bold">{category.label}</h2>
          <span className="rounded-full bg-stone-100 px-2 py-1 text-[11px] font-semibold text-stone-600">
            {selectedProject?.name ?? "No project selected"}
          </span>
          {targetFolder ? (
            <span className="rounded-full bg-cyan-50 px-2 py-1 text-[11px] font-semibold text-cyan-700">{targetFolder}</span>
          ) : null}
          <span className="inline-flex items-center gap-1 rounded-full bg-cyan-50 px-2 py-1 text-[11px] font-semibold text-cyan-700">
            <Hash className="h-3 w-3" />
            Camera {saveNumber || "0000"}
          </span>
        </div>

        <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-line bg-white text-stone-400 shadow-sm">
            {icon}
          </span>
          <p className="mt-3 text-sm font-semibold">No still image results for this project yet</p>
          <p className="mt-1 max-w-md text-xs leading-5 text-stone-500">
            {uploadedImages.length
              ? `${uploadedImages.length} input ready. Press Generate to send this ${category.label} job to its pod.`
              : category.instructions}
          </p>
          {/* The name the backend will save under, so the camera number can be
              checked before spending a render. Mirrors the server's naming; the
              version suffix is reserved at save time, hence the placeholder. */}
          <p className="mt-3 font-mono text-xs text-stone-500">
            {stillImageResultFileName({ project: selectedProject, modelName: category.label, saveNumber })}
          </p>
        </div>
      </article>
    </div>
  );
}

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-mist/70 px-2 py-1.5">
      <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-stone-500">
        {label === "Project" || label === "Folder" ? <Folder className="h-3 w-3" /> : <ImageIcon className="h-3 w-3" />}
        {label}
      </span>
      <p className="mt-1 truncate text-xs font-semibold capitalize text-ink">{value}</p>
    </div>
  );
}

function resultPlaceholderTitle(status: Job["status"]) {
  if (status === "failed") return "This job failed";
  if (status === "canceled") return "This job was canceled";
  if (status === "running" || status === "sending") return "Rendering on the preset pod";
  if (status === "queued") return "Queued";
  return "Generated image will appear here";
}

function formatTimestamp(value?: string) {
  if (!value) return "Unknown date";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleString();
}
