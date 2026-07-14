import { Archive, ArrowLeft, Hash, Loader2, Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FeedFilter, Job, Project, User } from "../types";
import { getJobSaveNumber, getJobSaveNumberLabel } from "../utils/saveNumber";
import { JobCard } from "./JobCard";

type JobFeedProps = {
  jobs: Job[];
  projects: Project[];
  users: User[];
  currentUserId: string;
  currentUserRole?: "admin" | "user";
  selectedProjectId: string;
  selectedFolderId: "all" | "root" | string;
  archiveView: boolean;
  favoriteJobIds: Set<string>;
  onDownload: (job: Job) => void;
  onCopyImage: (job: Job) => void;
  onReuseSettings: (job: Job) => void;
  canReuseSettings: (job: Job) => boolean;
  onToggleFavorite: (job: Job) => void;
  onArchive: (job: Job) => void;
  onRestore: (job: Job) => void;
  onDeletePermanently: (job: Job) => void;
  onUpdateJobSaveNumber: (job: Job, saveNumber: string) => void;
  onToggleArchiveView: () => void;
  totalJobs?: number;
  hasMoreJobs?: boolean;
  isLoadingMoreJobs?: boolean;
  onLoadMoreJobs?: () => void;
};

const filters: Array<{ id: FeedFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "mine", label: "My jobs" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
  { id: "video", label: "Video" },
  { id: "image", label: "Image" },
  { id: "favorites", label: "Favorites" },
];

export function JobFeed({
  jobs,
  projects,
  users,
  currentUserId,
  currentUserRole = "user",
  selectedProjectId,
  selectedFolderId,
  archiveView,
  favoriteJobIds,
  onDownload,
  onCopyImage,
  onReuseSettings,
  canReuseSettings,
  onToggleFavorite,
  onArchive,
  onRestore,
  onDeletePermanently,
  onUpdateJobSaveNumber,
  onToggleArchiveView,
  totalJobs,
  hasMoreJobs = false,
  isLoadingMoreJobs = false,
  onLoadMoreJobs,
}: JobFeedProps) {
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [query, setQuery] = useState("");
  const [modelFilter, setModelFilter] = useState("all");
  const [userFilter, setUserFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("all");
  const [saveNumberFilter, setSaveNumberFilter] = useState("");
  const [hasScrolled, setHasScrolled] = useState(false);
  const headerRef = useRef<HTMLElement>(null);

  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selectedFolder = selectedProject?.folders?.find((folder) => folder.folderId === selectedFolderId);
  const models = Array.from(new Set(jobs.map((job) => job.modelType)));
  const jobsForSelectedProject =
    selectedProjectId === "all"
      ? jobs
      : jobs.filter((job) => job.projectId === selectedProjectId);
  const jobsForSelectedFolder = jobsForSelectedProject.filter((job) => matchesSelectedFolder(job, selectedFolderId));

  const visibleJobs = useMemo(() => {
    const projectJobs =
      selectedProjectId === "all"
        ? jobs
        : jobs.filter((job) => job.projectId === selectedProjectId);
    const filteredJobs = projectJobs.filter((job) => {
      if (!matchesSelectedFolder(job, selectedFolderId)) return false;
      const project = projects.find((item) => item.id === job.projectId);
      const user = users.find((item) => item.id === job.userId);
      const hasSaveNumber = hasJobSaveNumber(job);
      const saveNumber = job.source === "existing_project_media" && !hasSaveNumber ? "" : getJobSaveNumber(job);
      const saveLabel = job.source === "existing_project_media" && !hasSaveNumber ? "" : getJobSaveNumberLabel(job);
      const searchable = `${job.title ?? ""} ${job.prompt} ${job.modelType} ${job.folderName ?? ""} ${job.id} ${project?.name ?? ""} ${user?.name ?? ""} ${saveLabel} ${saveNumber}`.toLowerCase();
      const normalizedQuery = query.trim().toLowerCase();
      const matchesQuery = !normalizedQuery || searchable.includes(normalizedQuery);
      const matchesModel = modelFilter === "all" || job.modelType === modelFilter;
      const matchesUser = currentUserRole !== "admin" || userFilter === "all" || job.userId === userFilter;
      const matchesDate = dateFilter === "all" || isWithinDays(job.createdAt, Number(dateFilter));
      const matchesSaveNumber = !saveNumberFilter || saveNumber.includes(saveNumberFilter);
      const matchesFilter =
        filter === "all" ||
        (filter === "mine" && job.userId === currentUserId) ||
        (filter === "completed" && job.status === "completed") ||
        (filter === "failed" && job.status === "failed") ||
        (filter === "video" && (job.outputType === "video" || job.outputType === "sequence" || Boolean(job.videoLength))) ||
        (filter === "image" && (job.outputType === "image" || (!job.outputType && !job.videoLength))) ||
        (filter === "favorites" && favoriteJobIds.has(job.id));

      return matchesQuery && matchesModel && matchesUser && matchesDate && matchesSaveNumber && matchesFilter;
    });

    if (import.meta.env.DEV) {
      console.debug("[ProjectFilter]", {
        selectedProjectId,
        selectedFolderId,
        totalJobs: jobs.length,
        jobsForSelectedProject: projectJobs.length,
        visibleJobs: filteredJobs.length,
      });
    }

    return filteredJobs;
  }, [currentUserId, currentUserRole, dateFilter, favoriteJobIds, filter, jobs, modelFilter, projects, query, saveNumberFilter, selectedFolderId, selectedProjectId, userFilter, users]);

  useEffect(() => {
    const scrollContainer = headerRef.current?.closest("main") as HTMLElement | null;

    if (!scrollContainer) {
      return;
    }

    const container = scrollContainer;

    function handleScroll() {
      setHasScrolled(container.scrollTop > 4);
    }

    handleScroll();
    container.addEventListener("scroll", handleScroll, { passive: true });

    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className="middle-panel pb-3">
      <section
        ref={headerRef}
        className={`jobs-header sticky top-0 z-30 mb-3 rounded-lg border border-line bg-white p-3 transition-shadow ${
          hasScrolled ? "shadow-card" : "shadow-panel"
        }`}
      >
        <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-bold">{archiveView ? "Archived results" : "AI generation jobs"}</h1>
              {selectedProject ? (
                <span className="rounded-full bg-teal-50 px-2 py-1 text-xs font-semibold text-teal-700">
                  {selectedProject.name}
                </span>
              ) : (
                <span className="rounded-full bg-stone-100 px-2 py-1 text-xs font-semibold text-stone-600">
                  All projects
                </span>
              )}
              {selectedProject && selectedFolderId !== "all" ? (
                <span className="rounded-full bg-cyan-50 px-2 py-1 text-xs font-semibold text-cyan-700">
                  {selectedFolderId === "root" ? "Root" : selectedFolder?.name ?? "Folder"}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-stone-500">
              {visibleJobs.length} visible of {jobsForSelectedFolder.length} loaded
              {typeof totalJobs === "number" ? ` / ${totalJobs} total` : ""}
            </p>
          </div>

          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap 2xl:max-w-[1040px]">
            <button
              type="button"
              onClick={onToggleArchiveView}
              className="flex h-10 items-center justify-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-semibold text-ink transition hover:border-accent hover:text-accent sm:flex-none"
            >
              {archiveView ? <ArrowLeft className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
              {archiveView ? "Results" : "Archive"}
            </button>
            <label className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search prompts, IDs, users, shots..."
                className="h-10 w-full rounded-md border border-line bg-white pl-10 pr-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
            </label>
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as FeedFilter)}
              className="h-10 rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 sm:w-32"
              aria-label="Job view filter"
            >
              {filters.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <label className="relative sm:w-36 sm:flex-none">
              <Hash className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
              <input
                value={saveNumberFilter}
                onChange={(event) => setSaveNumberFilter(event.target.value.replace(/\D/g, "").slice(0, 4))}
                inputMode="numeric"
                placeholder="Shot/camera"
                className="h-10 w-full rounded-md border border-line bg-white pl-9 pr-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                aria-label="Shot or camera number filter"
              />
            </label>
            <select
              value={modelFilter}
              onChange={(event) => setModelFilter(event.target.value)}
              className="h-10 rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
              aria-label="Model type filter"
            >
              <option value="all">All models</option>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            {currentUserRole === "admin" ? (
              <select
                value={userFilter}
                onChange={(event) => setUserFilter(event.target.value)}
                className="h-10 rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                aria-label="User filter"
              >
                <option value="all">All users</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            ) : null}
            <select
              value={dateFilter}
              onChange={(event) => setDateFilter(event.target.value)}
              className="h-10 rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
              aria-label="Date filter"
            >
              <option value="all">All dates</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
            </select>
          </div>
        </div>
      </section>

      {visibleJobs.length ? (
        <div className="space-y-3">
          {visibleJobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              project={projects.find((project) => project.id === job.projectId)}
              user={users.find((user) => user.id === job.userId)}
              isFavorite={favoriteJobIds.has(job.id)}
              canReuseSettings={canReuseSettings(job)}
              onDownload={onDownload}
              onCopyImage={onCopyImage}
              onReuseSettings={onReuseSettings}
              onToggleFavorite={onToggleFavorite}
              archiveView={archiveView}
              onArchive={onArchive}
              onRestore={onRestore}
              onDeletePermanently={onDeletePermanently}
              canEditSaveNumber={currentUserRole === "admin"}
              onUpdateSaveNumber={onUpdateJobSaveNumber}
            />
          ))}
          {hasMoreJobs && onLoadMoreJobs ? (
            <div className="flex justify-center py-2">
              <button
                type="button"
                onClick={onLoadMoreJobs}
                disabled={isLoadingMoreJobs}
                className="flex h-10 items-center gap-2 rounded-md border border-line bg-white px-4 text-sm font-semibold text-ink shadow-card transition hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-60"
              >
                {isLoadingMoreJobs ? <Loader2 className="h-4 w-4 animate-spin" /> : <SlidersHorizontal className="h-4 w-4" />}
                {isLoadingMoreJobs ? "Loading..." : archiveView ? "Load more archived results" : "Load more jobs"}
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="rounded-lg border border-line bg-white p-12 text-center shadow-card">
          <p className="text-sm font-semibold">{archiveView ? "No archived results match this view." : "No jobs match this view."}</p>
          <p className="mt-1 text-xs text-stone-500">Adjust filters or select a different project.</p>
          {hasMoreJobs && onLoadMoreJobs ? (
            <button
              type="button"
              onClick={onLoadMoreJobs}
              disabled={isLoadingMoreJobs}
              className="mt-4 inline-flex h-10 items-center gap-2 rounded-md border border-line bg-white px-4 text-sm font-semibold text-ink transition hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-60"
            >
              {isLoadingMoreJobs ? <Loader2 className="h-4 w-4 animate-spin" /> : <SlidersHorizontal className="h-4 w-4" />}
              {isLoadingMoreJobs ? "Loading..." : archiveView ? "Load more archived results" : "Load more jobs"}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function isWithinDays(date: string, days: number) {
  const now = new Date("2026-07-01T12:00:00Z").getTime();
  const target = new Date(date).getTime();
  return now - target <= days * 24 * 60 * 60 * 1000;
}

function matchesSelectedFolder(job: Job, selectedFolderId: "all" | "root" | string) {
  if (selectedFolderId === "all") return true;
  if (selectedFolderId === "root") return !job.folderId;
  return job.folderId === selectedFolderId;
}

function hasJobSaveNumber(job: Job) {
  return Boolean(job.workflowOptions?.save?.cameraNumber || job.workflowOptions?.save?.shotNumber);
}
