import {
  AlertTriangle,
  Calendar,
  Check,
  Copy,
  Download,
  Folder,
  Hash,
  ImageIcon,
  Images,
  Layers3,
  LoaderCircle,
  Maximize2,
  Search,
  Star,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  StillImageCategoryDefinition,
  StillImageCategoryId,
  StillImageCategoryState,
} from "../features/still-images/stillImageCategories";
import { STILL_IMAGE_CATEGORIES } from "../features/still-images/stillImageCategories";
import {
  formatPodRuntime,
  formatResultBytes,
  formatUsd,
  gpuDisplayName,
  measuredJobSpend,
  podCostExplanation,
} from "../features/still-images/podRuntimeCost";
import {
  DEFAULT_STILL_IMAGE_RESULT_FILTERS,
  filterStillImageJobs,
  hasActiveStillImageFilters,
  ROOT_FOLDER_FILTER,
  STILL_IMAGE_PRESET_FILTER_OPTIONS,
  type StillImageResultFilters,
} from "../features/still-images/resultFilters";
import { stillImageResultFileName } from "../features/still-images/resultFileName";
import { useStillImageResultView } from "../features/still-images/useStillImageResultView";
import { chainableResultUrl } from "../features/still-images/chainResult";
import { useNearViewport } from "../features/jobs/useNearViewport";
import { backendResultFileUrl, THUMBNAIL_WIDTH, thumbnailMediaUrl } from "../services/backendApi";
import type { Job, Project, User } from "../types";
import { FullscreenImagePreview, type FullscreenImage } from "./FullscreenImagePreview";
import { ImageCompareSlider } from "./ImageCompareSlider";
import { JobActions } from "./JobActions";
import { JobProgress } from "./JobProgress";
import { ResultOverlayActions, ResultOverlayButton, ResultOverlayLink } from "./ResultOverlayActions";
import { ResultTile } from "./ResultTile";
import { finalizedSessionSpend } from "../features/still-images/editDocument";
import { cn } from "../utils/classNames";
import { resultCardElementId } from "../utils/resultCard";
import { ArchiveViewToggle, JobStatusBadge, ResultLayoutToggle } from "./ResultViewControls";
import { UseAsInputMenu } from "./UseAsInputMenu";

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
  /** The signed-in account, for the "Mine" filter. Absent leaves that filter unoffered. */
  currentUserId?: string;
  // The same actions an Animation card offers. Passed through rather than
  // reimplemented so the two surfaces cannot drift into different behaviour for
  // download, archive or move.
  projects?: Project[];
  archiveView?: boolean;
  /** Switches the panel between active results and the archive, as Animation does. */
  onToggleArchiveView?: () => void;
  favoriteJobIds?: Set<string>;
  canReuseSettings?: (job: Job) => boolean;
  /** Chain this result into another preset as its first input. */
  onUseAsInput?: (job: Job, categoryId: StillImageCategoryId) => void;
  /**
   * Reopen the layer stack this composite was flattened from.
   *
   * Offered only where a document can actually be rebuilt, which the caller
   * decides -- the jobs have to still be loaded for there to be a stack.
   */
  onContinueEditing?: (job: Job) => void;
  canContinueEditing?: (job: Job) => boolean;
  /** The document being fetched, so its own button can say so. */
  reopeningEditDocument?: string;
  onDownload?: (job: Job) => void;
  onCopyImage?: (job: Job) => void;
  onReuseSettings?: (job: Job) => void;
  onRetry?: (job: Job) => void;
  /** Stop a queued or running job before it finishes paying for its pod time. */
  onCancel?: (job: Job) => void;
  onToggleFavorite?: (job: Job) => void;
  onMove?: (job: Job, destinationFolderId: string | null) => Promise<boolean>;
  onArchive?: (job: Job) => void;
  onRestore?: (job: Job) => void;
  onDeletePermanently?: (job: Job) => void;
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
  currentUserId,
  favoriteJobIds,
  ...actions
}: StillImagesWorkspaceProps) {
  const CategoryIcon = category.icon;
  const targetFolder = selectedProject?.folders?.find((folder) => folder.folderId === targetFolderId && !folder.archived);
  // Both outlive this mount: the panel is thrown away every time the section is
  // switched away from, and neither is a per-visit choice.
  const { filters, setFilters, layout, setLayout } = useStillImageResultView();
  // Which card to land on after leaving the grid.
  const [focusJobId, setFocusJobId] = useState<string | null>(null);
  const visibleJobs = useMemo(
    () => filterStillImageJobs(jobs, filters, { favoriteJobIds, currentUserId }),
    [jobs, filters, favoriteJobIds, currentUserId],
  );
  const filtering = hasActiveStillImageFilters(filters);

  useEffect(() => {
    if (layout !== "list" || !focusJobId) return;
    // Picking a tile out of fifty and being dropped at the top of the list would
    // mean scrolling to find it again, which is what the grid was there to avoid.
    //
    // Left set rather than cleared here: a stale id costs nothing, because this only
    // re-runs when the layout or the chosen card changes, and clearing it would be a
    // state write from inside an effect for no gain.
    const card = document.getElementById(resultCardElementId(focusJobId));
    card?.scrollIntoView?.({ block: "start" });
  }, [layout, focusJobId]);

  return (
    <div className="middle-panel pb-3">
      <section className="jobs-header sticky top-0 z-30 mb-3 rounded-lg border border-line bg-white p-3 shadow-panel">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold">Still image results</h1>
            <span className="rounded-full bg-teal-50 px-2 py-1 text-xs font-semibold text-teal-700">
              {selectedProject?.name ?? "Select project"}
            </span>
            {/* Where the next Generate will save, which is not a filter on this
                list. Unlabelled next to the project chip it read as one, while the
                list went on showing results from every folder in the project. */}
            {targetFolder ? (
              <span className="rounded-full bg-cyan-50 px-2 py-1 text-xs font-semibold text-cyan-700">
                Saving to {targetFolder.name}
              </span>
            ) : null}
            <span className="text-sm font-semibold text-stone-500">
              {resultCountLabel(visibleJobs.length, jobs.length, filtering)}
            </span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {/* The same control the Animation feed carries, from the same component,
                so the two sections cannot drift apart on what "Archived" looks like
                or does. Absent when the host does not wire it, which keeps the panel
                usable in tests and previews. */}
            {actions.onToggleArchiveView ? (
              <ArchiveViewToggle archiveView={actions.archiveView ?? false} onToggle={actions.onToggleArchiveView} />
            ) : null}
            <ResultLayoutToggle layout={layout} onChange={setLayout} />
          </div>
        </div>
        {jobs.length ? (
          <StillImageResultFilterBar
            filters={filters}
            onChange={setFilters}
            folders={selectedProject?.folders?.filter((folder) => !folder.archived) ?? []}
            // Each offered only where the panel was given what it needs to answer it,
            // the same rule the card actions follow. A "Mine" switch with no account
            // behind it would hide every result and look broken.
            offerFavorites={Boolean(favoriteJobIds)}
            offerMine={Boolean(currentUserId)}
          />
        ) : null}
      </section>

      {visibleJobs.length ? (
        layout === "grid" ? (
          // Every list card carries a compare slider up to 85vh tall, which is what
          // makes one result judgeable and thirty unfindable. The grid trades that
          // for a scannable contact sheet, and a tile switches back to the cards.
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visibleJobs.map((job) => (
              <ResultTile
                key={job.id}
                job={job}
                label={job.modelType}
                chip={job.workflowOptions?.save?.cameraNumber}
                onOpen={() => {
                  setFocusJobId(job.id);
                  setLayout("list");
                }}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {visibleJobs.map((job) => (
              <StillImageJobCard
                key={job.id}
                job={job}
                project={actions.projects?.find((item) => item.id === job.projectId) ?? selectedProject}
                selectedProject={selectedProject}
                userName={users.find((user) => user.id === job.userId)?.name ?? userName}
                isFavorite={favoriteJobIds?.has(job.id) ?? false}
                actions={actions}
              />
            ))}
          </div>
        )
      ) : filtering ? (
        // Not the same thing as an empty project, and must not be told as one: the
        // preset instructions and the filename preview would suggest nothing had
        // ever run here when the filters are simply hiding it.
        <NoMatchesState total={jobs.length} onClear={() => setFilters(DEFAULT_STILL_IMAGE_RESULT_FILTERS)} />
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

/**
 * How many results the list is showing.
 *
 * A filtered list has to say it is a subset -- "1 of 12" -- or it reads as the whole
 * project and someone concludes the rest of their renders are gone. One string
 * rather than interpolated fragments so it stays one text node, which is also how
 * anything reading the header sees it.
 */
function resultCountLabel(shown: number, total: number, filtering: boolean) {
  if (filtering) return `${shown} of ${total} result${total === 1 ? "" : "s"}`;
  return `${total} result${total === 1 ? "" : "s"}`;
}

const FILTER_SELECT_CLASS =
  "h-9 min-w-0 rounded-md border border-line bg-white px-2 text-xs font-semibold outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20";

/** An on/off narrowing, sized to sit in the same row as the selects. */
function FilterToggle({
  icon,
  label,
  pressed,
  onToggle,
}: {
  icon: React.ReactNode;
  label: string;
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={pressed}
      className={cn(
        "flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition",
        pressed
          ? "border-accent bg-accent text-white"
          : "border-line bg-white text-stone-600 hover:border-accent hover:text-accent",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function StillImageResultFilterBar({
  filters,
  onChange,
  folders,
  offerFavorites,
  offerMine,
}: {
  filters: StillImageResultFilters;
  onChange: (filters: StillImageResultFilters) => void;
  folders: Array<{ folderId: string; name: string }>;
  offerFavorites: boolean;
  offerMine: boolean;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
      <label className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400" />
        <input
          type="search"
          aria-label="Search results"
          value={filters.query}
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
          placeholder="Search prompt, file, camera, seed"
          className="h-9 w-full rounded-md border border-line bg-white pl-8 pr-2 text-xs outline-none transition placeholder:text-stone-400 focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
      </label>
      <select
        aria-label="Filter by preset"
        value={filters.presetId}
        onChange={(event) => onChange({ ...filters, presetId: event.target.value as StillImageResultFilters["presetId"] })}
        className={FILTER_SELECT_CLASS}
      >
        <option value="all">All presets</option>
        {STILL_IMAGE_PRESET_FILTER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter by status"
        value={filters.status}
        onChange={(event) => onChange({ ...filters, status: event.target.value as StillImageResultFilters["status"] })}
        className={FILTER_SELECT_CLASS}
      >
        <option value="all">Any status</option>
        <option value="completed">Completed</option>
        <option value="working">Working</option>
        <option value="failed">Failed or canceled</option>
      </select>
      <select
        aria-label="Filter by folder"
        value={filters.folderId}
        onChange={(event) => onChange({ ...filters, folderId: event.target.value })}
        className={FILTER_SELECT_CLASS}
      >
        <option value="all">All folders</option>
        <option value={ROOT_FOLDER_FILTER}>Project root</option>
        {folders.map((folder) => (
          <option key={folder.folderId} value={folder.folderId}>
            {folder.name}
          </option>
        ))}
      </select>
      <select
        aria-label="Sort results"
        value={filters.sort}
        onChange={(event) => onChange({ ...filters, sort: event.target.value as StillImageResultFilters["sort"] })}
        className={FILTER_SELECT_CLASS}
      >
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="cost">Most expensive first</option>
      </select>
      {/* The two personal narrowings, as switches rather than another select: they are
          not alternatives to each other and both are commonly on at once -- "the ones
          I starred" and "the ones I ran" are different questions. */}
      {offerFavorites ? (
        <FilterToggle
          icon={<Star className={cn("h-3.5 w-3.5", filters.favoritesOnly && "fill-current")} />}
          label="Favourites"
          pressed={filters.favoritesOnly}
          onToggle={() => onChange({ ...filters, favoritesOnly: !filters.favoritesOnly })}
        />
      ) : null}
      {offerMine ? (
        <FilterToggle
          icon={<UserRound className="h-3.5 w-3.5" />}
          label="Mine"
          pressed={filters.mineOnly}
          onToggle={() => onChange({ ...filters, mineOnly: !filters.mineOnly })}
        />
      ) : null}
      {hasActiveStillImageFilters(filters) ? (
        <button
          type="button"
          onClick={() => onChange({ ...DEFAULT_STILL_IMAGE_RESULT_FILTERS, sort: filters.sort })}
          className="h-9 rounded-md border border-line bg-white px-2.5 text-xs font-semibold text-stone-600 transition hover:border-accent hover:text-accent"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}

function NoMatchesState({ total, onClear }: { total: number; onClear: () => void }) {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center rounded-lg border border-dashed border-line bg-white px-6 text-center shadow-card">
      <span className="flex h-12 w-12 items-center justify-center rounded-full border border-line bg-white text-stone-400 shadow-sm">
        <Search className="h-5 w-5" />
      </span>
      <p className="mt-3 text-sm font-semibold">No result matches these filters</p>
      <p className="mt-1 max-w-md text-xs leading-5 text-stone-500">
        This project has {total} still image result{total === 1 ? "" : "s"}, and none of them match what is selected above.
      </p>
      <button
        type="button"
        onClick={onClear}
        className="mt-3 h-9 rounded-md border border-line bg-white px-3 text-xs font-semibold text-stone-700 transition hover:border-accent hover:text-accent"
      >
        Clear filters
      </button>
    </div>
  );
}

type StillImageActions = Omit<
  StillImagesWorkspaceProps,
  | "category"
  | "state"
  | "selectedProject"
  | "targetFolderId"
  | "saveNumber"
  | "userName"
  | "jobs"
  | "users"
  | "currentUserId"
  | "favoriteJobIds"
>;

function StillImageJobCard({
  job,
  project,
  selectedProject,
  userName,
  isFavorite,
  actions,
}: {
  job: Job;
  project?: Project;
  /** Where a new job would be submitted, which is not always this job's project. */
  selectedProject?: Project;
  userName: string;
  isFavorite: boolean;
  actions: StillImageActions;
}) {
  const preset = STILL_IMAGE_CATEGORIES.find((entry) => entry.id === job.workflowOptions?.stillImage?.categoryId);
  const PresetIcon = preset?.icon ?? ImageIcon;
  const resultUrl = job.resultUrl ?? job.thumbnailUrl;
  const inputImages = job.inputImages.filter(Boolean);
  const saveNumber = job.workflowOptions?.save?.cameraNumber ?? "0000";
  const qwenMode = job.workflowOptions?.stillImage?.settings?.mode;
  const seed = job.workflowOptions?.stillImage?.seed;
  // The whole run: the pod it rented plus the partner node it called. Showing the
  // pod alone reported an eight-cent edit as half a cent.
  const sessionSpend = finalizedSessionSpend(job);
  const spend = measuredJobSpend(job);
  const podCost = spend === undefined ? undefined : formatUsd(spend.usd);
  const podRuntime = formatPodRuntime(job);
  const gpu = gpuDisplayName(job.runpodTiming?.gpuTypeId);
  const resultBytes = formatResultBytes(job.outputBytes);

  return (
    <article id={resultCardElementId(job.id)} className="job-card-cv rounded-lg border border-line bg-white p-4 shadow-card">
      {/* Always a row, so the actions stay in the top-right corner. This used to
          become one only at xl, which put the toolbar underneath the title on
          any window narrower than 1280px -- which is most of them. */}
      <div className="flex flex-row items-start justify-between gap-3 border-b border-line pb-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <JobStatusBadge status={job.status} />
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

        {/* The same toolbar the Animation cards carry -- download, copy, reuse,
            retry, favourite, move, archive. Rendered from the shared component
            rather than rebuilt, so the two surfaces cannot drift apart. Absent
            when the handlers are not supplied, which keeps the panel usable in
            tests and previews that do not wire them. */}
        {actions.onDownload ? (
          // shrink-0 so the toolbar keeps its size and the badges wrap instead.
          <div className="shrink-0">
            <JobActions
              job={job}
              project={project}
              isFavorite={isFavorite}
              canReuseSettings={actions.canReuseSettings?.(job) ?? false}
              archiveView={actions.archiveView ?? false}
              onDownload={actions.onDownload}
              onCopyImage={actions.onCopyImage ?? noop}
              onReuseSettings={actions.onReuseSettings ?? noop}
              onRetry={actions.onRetry ?? noop}
              onCancel={actions.onCancel ?? noop}
              onToggleFavorite={actions.onToggleFavorite ?? noop}
              onMove={actions.onMove ?? (async () => false)}
              onArchive={actions.onArchive ?? noop}
              onRestore={actions.onRestore ?? noop}
              onDeletePermanently={actions.onDeletePermanently ?? noop}
            />
          </div>
        ) : null}
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

        <section className="result-section mt-4">
          {resultUrl && job.status === "completed" ? (
            <StillImageResult
              job={job}
              url={resultUrl}
              onUseAsInput={actions.onUseAsInput}
              onContinueEditing={actions.canContinueEditing?.(job) ? actions.onContinueEditing : undefined}
              reopening={
                actions.reopeningEditDocument !== undefined &&
                actions.reopeningEditDocument === job.workflowOptions?.stillImage?.settings?.documentId
              }
              chainDisabledReason={chainBlockedReason(job, selectedProject)}
            />
          ) : isJobWorking(job.status) ? (
            <div className="flex min-h-72 w-full flex-col items-center justify-center rounded-lg border border-dashed border-line bg-mist/60 px-6">
              <JobProgress job={job} />
            </div>
          ) : (
            <div className="flex min-h-72 w-full flex-col items-center justify-center rounded-lg border border-dashed border-line bg-mist/60 px-6 text-center">
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
        {/* Who submitted it. Projects are studio-wide, so a result in the list is
            as likely to be someone else's as your own. */}
        <MetadataItem label="User" value={userName} />
        <MetadataItem label="Input" value={`${inputImages.length} image${inputImages.length === 1 ? "" : "s"}`} />
        <MetadataItem label="Camera" value={saveNumber} />
        {/* What Reuse settings puts back in the form to render this take again.
            Older results predate seeds being recorded and show a dash.

            Copyable because the whole cell is one truncated line: reproducing a take
            in a different project, or quoting it to whoever asked for it, meant
            reading a ten-digit number off the card and retyping it. */}
        <MetadataItem
          label="Seed"
          value={seed === undefined ? "--" : String(seed)}
          copyValue={seed === undefined ? undefined : String(seed)}
        />
        <MetadataItem label="Project" value={project?.shortName ?? "Not selected"} />
        <MetadataItem label="Folder" value={job.folderName ?? "Root"} />
        {/* Measured, or nothing. These pods return no usage figures, so a cost
            exists only where RunPod reported worker time and the GPU behind the
            worker is one we have a rate for; anything else would be the old flat
            estimate wearing a cost label.

            Shown in dollars because that is what the pods are rented in and what an
            artist can weigh a re-render against. The credit figure the balance and
            the dashboards use is in the tooltip. */}
        <MetadataItem label="Cost" value={podCost ?? "--"} hint={podCostExplanation(job)} />
        {/* The two accounts, apart. They answer different questions: pod time
            falls on a faster GPU, Comfy credits only fall by calling the model
            fewer times, and a single total says which lever to reach for. */}
        {spend?.comfyCredits ? (
          <>
            <MetadataItem
              label="Pod"
              value={formatUsd(spend.podUsd) ?? "--"}
              hint={`RunPod worker time, rented by the second. ${spend.podCredits} credit${spend.podCredits === 1 ? "" : "s"}.`}
            />
            <MetadataItem
              label="Comfy"
              value={formatUsd(spend.comfyUsd) ?? "--"}
              hint={`Comfy credits for the partner API nodes this graph called. ${spend.comfyCredits} credits.`}
            />
          </>
        ) : null}
        {/* A composite cost nothing to flatten -- the spend is the session of
            generations behind it, which is the figure worth showing on the one
            card that represents the whole document. */}
        {sessionSpend ? (
          <MetadataItem
            label="Session"
            value={formatUsd(sessionSpend.usd) ?? "--"}
            hint={`${formatUsd(sessionSpend.podUsd)} of pod time and ${formatUsd(sessionSpend.comfyUsd)} of Comfy credits (${
              sessionSpend.credits
            } credits) across ${sessionSpend.generations} generation${
              sessionSpend.generations === 1 ? "" : "s"
            } in this editing session, including takes that were replaced.`}
          />
        ) : null}
        {/* Worker time, not the wall clock on the card: a job also waits in RunPod's
            queue, and that wait is not billed. */}
        <MetadataItem label="Pod time" value={podRuntime ?? "--"} hint="Time a worker spent on this job." />
        {/* Which GPU the endpoint happened to schedule this onto, and therefore what
            it was priced at. The endpoints accept two or three classes each, so this
            is the difference between an 8-credit run and an 18-credit one. */}
        <MetadataItem
          label="GPU"
          value={gpu ?? "--"}
          hint={gpu ? job.runpodTiming?.gpuTypeId : "The worker's GPU was not identified for this run."}
        />
        {/* What came out, which for an upscaler is the whole point of the run. The
            pixels are known for every result; the megabytes only for those rendered
            since the size started being recorded, so they ride in the tooltip
            rather than leaving a second cell empty on older cards. */}
        <MetadataItem
          label="Result size"
          value={job.outputResolution?.label ?? formatResolution(job.outputResolution) ?? "--"}
          hint={resultBytes ? `${resultBytes} on disk.` : "Size on disk was not recorded for this result."}
        />
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
 *
 * The viewer is the same one the Animation cards use. Every preset here is a
 * before-and-after -- enhance, upscale, edit, transfer -- and judging one against
 * a 128px input chip elsewhere on the card was never really possible.
 */
/**
 * Why this result cannot be chained into the next preset, if it cannot.
 *
 * The server accepts a saved-media input only when the file sits inside the
 * submitting project's own folder, and with All projects selected this panel
 * lists results from every project. Without this the menu would offer a send
 * that fails at Generate, after the artist had set everything else up.
 */
function chainBlockedReason(job: Job, selectedProject?: Project) {
  if (!selectedProject) return "Select a project before sending a result to a preset.";
  if (job.projectId !== selectedProject.id) {
    return "This result belongs to another project. Open that project to use it as an input.";
  }
  // A result still sitting on the provider's storage has no path on disk to submit,
  // and the presets cannot take a link. Said here rather than discovered at Generate.
  if (!chainableResultUrl(job)) {
    return "This result has not been saved into the project yet, so it cannot be used as an input.";
  }
  return undefined;
}

function StillImageResult({
  job,
  url,
  onUseAsInput,
  onContinueEditing,
  reopening = false,
  chainDisabledReason,
}: {
  job: Job;
  url: string;
  onUseAsInput?: (job: Job, categoryId: StillImageCategoryId) => void;
  onContinueEditing?: (job: Job) => void;
  reopening?: boolean;
  chainDisabledReason?: string;
}) {
  const [containerRef, inView] = useNearViewport<HTMLDivElement>();
  const [fullscreenImage, setFullscreenImage] = useState<FullscreenImage | null>(null);
  const name = job.fileName ?? `${job.modelType} result`;
  // Slot 1 for every preset: the main image for Reference Generator and Qwen
  // Edit, whose later slots are a reference or a second subject rather than the
  // thing being changed. Comparing against those would be meaningless.
  const inputUrl = job.inputImages.filter(Boolean)[0];
  // Matched renditions. Both sides are downscaled the same way so the comparison
  // is like-for-like at screen size; Pro Upscaler's extra resolution is a
  // question for the fullscreen preview's original, not for a card.
  const beforeImage = inputUrl ? thumbnailMediaUrl(inputUrl, THUMBNAIL_WIDTH.fullscreen) : undefined;
  const afterImage = thumbnailMediaUrl(url, THUMBNAIL_WIDTH.fullscreen);

  return (
    <div ref={containerRef} className="relative w-full">
      {inView ? (
        // 1440, the largest rendition. The card spans the panel and these are the
        // studio's own renders being judged, so softness reads as a quality
        // problem with the render itself. Still a rendition -- the original can
        // be 100+ MB and is only ever fetched by Download.
        <ImageCompareSlider
          beforeImage={beforeImage}
          afterImage={afterImage}
          beforeLabel="Input"
          afterLabel="Result"
          maxHeight="85vh"
        />
      ) : (
        // Only a placeholder height: the real one is unknown until the image
        // loads, and guessing would make the page jump twice instead of once.
        <div className="flex min-h-[20rem] w-full items-center justify-center overflow-hidden rounded-lg border border-line bg-stone-100">
          <span className="rounded-full bg-white px-3 py-2 text-xs font-semibold text-stone-500 shadow-card">Result preview</span>
        </div>
      )}

      <ResultOverlayActions>
        {/* Chaining costs nothing: the result is already saved project media, so
            the next job is submitted against the same path on disk rather than a
            re-upload of a file that never left the server. */}
        {onContinueEditing ? (
          // Distinct from chaining: chaining takes the flattened picture as a new
          // original, which bakes every layer in. This reopens the stack itself,
          // so an opacity or a mask set an hour ago is still adjustable.
          <button
            type="button"
            onClick={() => onContinueEditing(job)}
            disabled={reopening}
            title="Reopen this composite's layer stack for further editing"
            className="flex h-8 items-center gap-1.5 rounded-md border border-accent/60 bg-white/95 px-2.5 text-xs font-bold text-accent shadow-card transition hover:bg-cyan-50 disabled:cursor-wait disabled:opacity-60"
          >
            {reopening ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Layers3 className="h-3.5 w-3.5" />}
            {reopening ? "Opening…" : "Continue editing"}
          </button>
        ) : null}
        {onUseAsInput ? (
          <UseAsInputMenu onSelect={(categoryId) => onUseAsInput(job, categoryId)} disabledReason={chainDisabledReason} />
        ) : null}
        <ResultOverlayButton
          icon={<Maximize2 className="h-4 w-4" />}
          label="Open preview"
          onClick={() =>
            setFullscreenImage({
              previewUrl: afterImage,
              name,
              downloadUrl: backendResultFileUrl(job.id, 0),
              // Un-downscaled, for the "View full resolution" button only.
              originalUrl: url,
              // Carried through so the comparison survives going fullscreen,
              // which is where it is worth the most.
              beforeUrl: beforeImage,
            })
          }
        />
        {/* A plain link, not a fetch: the backend already answers this with
            Content-Disposition: attachment, so the browser streams it to disk
            without the page ever holding the bytes. */}
        <ResultOverlayLink
          icon={<Download className="h-4 w-4" />}
          label="Download original"
          href={backendResultFileUrl(job.id, 0)}
        />
      </ResultOverlayActions>

      {fullscreenImage ? <FullscreenImagePreview image={fullscreenImage} onClose={() => setFullscreenImage(null)} /> : null}
    </div>
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

/** For a resolution stored before the label was, or one that lost it in transit. */
function formatResolution(resolution: Job["outputResolution"]) {
  if (!resolution?.width || !resolution?.height) return undefined;
  return `${Math.round(resolution.width)} \u00d7 ${Math.round(resolution.height)}`;
}

function MetadataItem({
  label,
  value,
  hint,
  copyValue,
}: {
  label: string;
  value: string;
  hint?: string;
  /** Makes the cell a copy button. Omit for a cell whose value is nobody's to reuse. */
  copyValue?: string;
}) {
  return (
    <div className="min-w-0 rounded-md bg-mist/70 px-2 py-1.5" title={hint}>
      <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-stone-500">
        {label === "Project" || label === "Folder" ? <Folder className="h-3 w-3" /> : <ImageIcon className="h-3 w-3" />}
        {label}
      </span>
      {copyValue ? (
        <CopyableValue label={label} value={value} copyValue={copyValue} />
      ) : (
        <p className="mt-1 truncate text-xs font-semibold capitalize text-ink">{value}</p>
      )}
    </div>
  );
}

/**
 * A metadata value that can be taken away.
 *
 * Falls back to plain text where the clipboard is unavailable -- an insecure origin,
 * or a browser withholding permission -- rather than offering a button that silently
 * does nothing.
 */
function CopyableValue({ label, value, copyValue }: { label: string; value: string; copyValue: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return <p className="mt-1 truncate text-xs font-semibold capitalize text-ink">{value}</p>;
  }

  return (
    <button
      type="button"
      title={copied ? "Copied" : `Copy ${label.toLowerCase()}`}
      aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()} ${copyValue}`}
      onClick={() => {
        // Nothing to report on failure beyond not confirming: the value is on screen
        // and selectable, so a rejected clipboard leaves the artist no worse off.
        void navigator.clipboard.writeText(copyValue).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
      className="mt-1 flex w-full items-center gap-1 text-left text-xs font-semibold capitalize text-ink transition hover:text-accent"
    >
      <span className="truncate">{value}</span>
      {copied ? <Check className="h-3 w-3 shrink-0 text-teal-600" /> : <Copy className="h-3 w-3 shrink-0 text-stone-400" />}
    </button>
  );
}

/** Stand-in for an action the host did not wire; JobActions requires them all. */
function noop() {}

function isJobWorking(status: Job["status"]) {
  return status === "queued" || status === "sending" || status === "running";
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
