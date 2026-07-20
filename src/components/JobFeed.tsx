import {
  Archive,
  CheckCircle2,
  ChevronDown,
  Hash,
  Loader2,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Job, JobStatus, Project, User } from "../types";
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
  onMove: (job: Job, destinationFolderId: string | null) => Promise<boolean>;
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

type StatusFilter = "all" | JobStatus;
type ScopeFilter = "all" | "mine" | "favorites";
type OutputFilter = "all" | "image" | "video";
type SortMode = "newest" | "oldest" | "recent_completed" | "credits_desc" | "credits_asc" | "generation_desc";

const statusFilters: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "queued", label: "Queued" },
  { id: "sending", label: "Sending" },
  { id: "running", label: "Running" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
  { id: "canceled", label: "Canceled" },
];

const scopeFilters: Array<{ id: ScopeFilter; label: string }> = [
  { id: "all", label: "All jobs" },
  { id: "mine", label: "My jobs" },
  { id: "favorites", label: "Favorites" },
];

const outputFilters: Array<{ id: OutputFilter; label: string }> = [
  { id: "all", label: "Any type" },
  { id: "image", label: "Image" },
  { id: "video", label: "Video" },
];

const dateFilters = [
  { id: "all", label: "Any time" },
  { id: "7", label: "Last 7 days" },
  { id: "30", label: "Last 30 days" },
];

const sortOptions: Array<{ id: SortMode; label: string }> = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "recent_completed", label: "Recently completed" },
  { id: "credits_desc", label: "Highest credits" },
  { id: "credits_asc", label: "Lowest credits" },
  { id: "generation_desc", label: "Longest generation time" },
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
  onMove,
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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [modelFilter, setModelFilter] = useState("all");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [userFilter, setUserFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("all");
  const [saveNumberFilter, setSaveNumberFilter] = useState("");
  const [outputFilter, setOutputFilter] = useState<OutputFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const filterPanelRef = useRef<HTMLDivElement>(null);

  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selectedFolder = selectedProject?.folders?.find((folder) => folder.folderId === selectedFolderId);
  const models = Array.from(new Set(jobs.map((job) => job.modelType))).sort((a, b) => a.localeCompare(b));
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
      const matchesStatus = statusFilter === "all" || job.status === statusFilter;
      const matchesModel = modelFilter === "all" || job.modelType === modelFilter;
      const matchesScope =
        scopeFilter === "all" ||
        (scopeFilter === "mine" && job.userId === currentUserId) ||
        (scopeFilter === "favorites" && favoriteJobIds.has(job.id));
      const matchesUser = currentUserRole !== "admin" || userFilter === "all" || job.userId === userFilter;
      const matchesDate = dateFilter === "all" || isWithinDays(job.createdAt, Number(dateFilter));
      const matchesSaveNumber = !saveNumberFilter || saveNumber.includes(saveNumberFilter);
      const matchesOutput =
        outputFilter === "all" ||
        (outputFilter === "video" && (job.outputType === "video" || job.outputType === "sequence" || Boolean(job.videoLength))) ||
        (outputFilter === "image" && (job.outputType === "image" || (!job.outputType && !job.videoLength)));

      return matchesQuery && matchesStatus && matchesModel && matchesScope && matchesUser && matchesDate && matchesSaveNumber && matchesOutput;
    });
    const sortedJobs = [...filteredJobs].sort((a, b) => compareJobs(a, b, sortMode));

    if (import.meta.env.DEV) {
      console.debug("[ProjectFilter]", {
        selectedProjectId,
        selectedFolderId,
        totalJobs: jobs.length,
        jobsForSelectedProject: projectJobs.length,
        visibleJobs: sortedJobs.length,
      });
    }

    return sortedJobs;
  }, [
    currentUserId,
    currentUserRole,
    dateFilter,
    favoriteJobIds,
    jobs,
    modelFilter,
    outputFilter,
    projects,
    query,
    saveNumberFilter,
    scopeFilter,
    selectedFolderId,
    selectedProjectId,
    sortMode,
    statusFilter,
    userFilter,
    users,
  ]);

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

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable;
      if (event.key === "/" && !event.altKey && !event.ctrlKey && !event.metaKey && !isTyping) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if (event.key === "Escape") {
        setIsFilterPanelOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!filterPanelRef.current?.contains(event.target as Node)) {
        setIsFilterPanelOpen(false);
      }
    }

    if (!isFilterPanelOpen) return;
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isFilterPanelOpen]);

  const activeFilterChips = [
    statusFilter !== "all"
      ? {
          key: "status",
          label: `Status: ${getOptionLabel(statusFilters, statusFilter)}`,
          onRemove: () => setStatusFilter("all"),
        }
      : undefined,
    modelFilter !== "all"
      ? {
          key: "model",
          label: `Model: ${modelFilter}`,
          onRemove: () => setModelFilter("all"),
        }
      : undefined,
    scopeFilter !== "all"
      ? {
          key: "scope",
          label: `Scope: ${getOptionLabel(scopeFilters, scopeFilter)}`,
          onRemove: () => setScopeFilter("all"),
        }
      : undefined,
    currentUserRole === "admin" && userFilter !== "all"
      ? {
          key: "user",
          label: `User: ${users.find((user) => user.id === userFilter)?.name ?? "Selected"}`,
          onRemove: () => setUserFilter("all"),
        }
      : undefined,
    dateFilter !== "all"
      ? {
          key: "date",
          label: `Date: ${getOptionLabel(dateFilters, dateFilter)}`,
          onRemove: () => setDateFilter("all"),
        }
      : undefined,
    saveNumberFilter
      ? {
          key: "shot",
          label: `Shot: ${saveNumberFilter}`,
          onRemove: () => setSaveNumberFilter(""),
        }
      : undefined,
    outputFilter !== "all"
      ? {
          key: "type",
          label: `Type: ${getOptionLabel(outputFilters, outputFilter)}`,
          onRemove: () => setOutputFilter("all"),
        }
      : undefined,
  ].filter((chip): chip is { key: string; label: string; onRemove: () => void } => Boolean(chip));

  const popoverFilterCount = [
    scopeFilter !== "all",
    currentUserRole === "admin" && userFilter !== "all",
    dateFilter !== "all",
    Boolean(saveNumberFilter),
    outputFilter !== "all",
  ].filter(Boolean).length;
  const resultCountLabel = getResultCountLabel({
    visibleCount: visibleJobs.length,
    loadedCount: jobsForSelectedFolder.length,
    totalCount: totalJobs,
    hasMoreJobs,
    isLoadingMoreJobs,
  });

  function clearAllFilters() {
    setStatusFilter("all");
    setModelFilter("all");
    setScopeFilter("all");
    setUserFilter("all");
    setDateFilter("all");
    setSaveNumberFilter("");
    setOutputFilter("all");
  }

  function resetPopoverFilters() {
    setScopeFilter("all");
    setUserFilter("all");
    setDateFilter("all");
    setSaveNumberFilter("");
    setOutputFilter("all");
  }

  return (
    <div className="middle-panel pb-3">
      <section
        ref={headerRef}
        className={`jobs-header sticky top-0 z-30 mb-3 rounded-lg border border-line bg-white p-3 transition-shadow ${
          hasScrolled ? "shadow-card" : "shadow-panel"
        }`}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="text-lg font-bold">AI generation jobs</h1>
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
              <span className="text-sm font-semibold text-stone-500">{resultCountLabel}</span>
            </div>

            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
              <div className="grid h-10 grid-cols-2 rounded-md border border-line bg-mist/70 p-1">
                <button
                  type="button"
                  onClick={() => {
                    if (archiveView) onToggleArchiveView();
                  }}
                  className={`rounded px-3 text-sm font-semibold transition ${
                    archiveView ? "text-stone-600 hover:bg-white hover:text-ink" : "bg-white text-ink shadow-sm"
                  }`}
                  aria-pressed={!archiveView}
                >
                  Active
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!archiveView) onToggleArchiveView();
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded px-3 text-sm font-semibold transition ${
                    archiveView ? "bg-white text-ink shadow-sm" : "text-stone-600 hover:bg-white hover:text-ink"
                  }`}
                  aria-pressed={archiveView}
                >
                  <Archive className="h-3.5 w-3.5" />
                  Archived
                </button>
              </div>
              <label className="relative min-w-[11rem]">
                <span className="sr-only">Sort jobs</span>
                <select
                  value={sortMode}
                  onChange={(event) => setSortMode(event.target.value as SortMode)}
                  className="h-10 w-full appearance-none rounded-md border border-line bg-white px-3 pr-9 text-sm font-semibold text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                  aria-label="Sort jobs"
                >
                  {sortOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
              </label>
            </div>
          </div>

          <div className="grid gap-2 xl:grid-cols-[minmax(18rem,1fr)_10rem_minmax(12rem,15rem)_auto]">
            <label className="relative min-w-0" title="Search prompts, IDs, users, shots, cameras, projects, and models. Press / to focus.">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search jobs..."
                className="h-10 w-full rounded-md border border-line bg-white pl-10 pr-10 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-stone-500 transition hover:bg-stone-100 hover:text-ink"
                  title="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </label>
            <label className="relative">
              <span className="sr-only">Status filter</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                className="h-10 w-full appearance-none rounded-md border border-line bg-white px-3 pr-9 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                aria-label="Status filter"
              >
                {statusFilters.map((item) => (
                  <option key={item.id} value={item.id}>
                    Status: {item.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
            </label>
            <label className="relative min-w-0">
              <span className="sr-only">Model filter</span>
              <select
                value={modelFilter}
                onChange={(event) => setModelFilter(event.target.value)}
                className="h-10 w-full appearance-none truncate rounded-md border border-line bg-white px-3 pr-9 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                aria-label="Model type filter"
              >
                <option value="all">Model: All</option>
                {models.map((model) => (
                  <option key={model} value={model}>
                    Model: {model}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
            </label>
            <div ref={filterPanelRef} className="relative">
              <button
                type="button"
                onClick={() => setIsFilterPanelOpen((value) => !value)}
                className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-semibold text-ink transition hover:border-accent hover:text-accent focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 xl:w-auto"
                aria-expanded={isFilterPanelOpen}
                aria-controls="job-filter-panel"
              >
                <SlidersHorizontal className="h-4 w-4" />
                {popoverFilterCount ? `Filters (${popoverFilterCount})` : "Filters"}
                <ChevronDown className="h-4 w-4 text-stone-400" />
              </button>
              {isFilterPanelOpen ? (
                <div
                  id="job-filter-panel"
                  className="absolute right-0 top-12 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-line bg-white p-3 text-sm shadow-panel"
                >
                  <div className="flex items-center justify-between gap-3 border-b border-line pb-2">
                    <p className="font-bold text-ink">Filters</p>
                    <button
                      type="button"
                      onClick={() => setIsFilterPanelOpen(false)}
                      className="flex h-7 w-7 items-center justify-center rounded text-stone-500 transition hover:bg-stone-100 hover:text-ink"
                      title="Close filters"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-3 grid gap-3">
                    <label className="grid gap-1.5">
                      <span className="text-xs font-semibold text-stone-500">Scope</span>
                      <select
                        value={scopeFilter}
                        onChange={(event) => setScopeFilter(event.target.value as ScopeFilter)}
                        className="h-10 rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                      >
                        {scopeFilters.map((item) => (
                          <option key={item.id} value={item.id}>
                            Scope: {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {currentUserRole === "admin" ? (
                      <label className="grid gap-1.5">
                        <span className="text-xs font-semibold text-stone-500">Specific user</span>
                        <select
                          value={userFilter}
                          onChange={(event) => setUserFilter(event.target.value)}
                          className="h-10 rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                        >
                          <option value="all">User: Anyone</option>
                          {users.map((user) => (
                            <option key={user.id} value={user.id}>
                              User: {user.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <label className="grid gap-1.5">
                      <span className="text-xs font-semibold text-stone-500">Date range</span>
                      <select
                        value={dateFilter}
                        onChange={(event) => setDateFilter(event.target.value)}
                        className="h-10 rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                      >
                        {dateFilters.map((item) => (
                          <option key={item.id} value={item.id}>
                            Date: {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1.5">
                      <span className="text-xs font-semibold text-stone-500">Shot or camera</span>
                      <span className="relative">
                        <Hash className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                        <input
                          value={saveNumberFilter}
                          onChange={(event) => setSaveNumberFilter(event.target.value.replace(/\D/g, "").slice(0, 4))}
                          inputMode="numeric"
                          placeholder="Shot or camera #"
                          className="h-10 w-full rounded-md border border-line bg-white pl-9 pr-3 text-sm text-ink outline-none transition placeholder:text-stone-400 focus:border-accent focus:ring-2 focus:ring-accent/20"
                          aria-label="Shot or camera number filter"
                        />
                      </span>
                    </label>
                    <label className="grid gap-1.5">
                      <span className="text-xs font-semibold text-stone-500">Generation type</span>
                      <select
                        value={outputFilter}
                        onChange={(event) => setOutputFilter(event.target.value as OutputFilter)}
                        className="h-10 rounded-md border border-line bg-white px-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                      >
                        {outputFilters.map((item) => (
                          <option key={item.id} value={item.id}>
                            Type: {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
                    <button
                      type="button"
                      onClick={resetPopoverFilters}
                      className="h-9 rounded-md px-3 text-sm font-semibold text-stone-600 transition hover:bg-stone-100 hover:text-ink"
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsFilterPanelOpen(false)}
                      className="flex h-9 items-center gap-2 rounded-md bg-ink px-3 text-sm font-semibold text-white transition hover:bg-stone-800"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      Apply
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {activeFilterChips.length ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              {activeFilterChips.map((chip) => (
                <span
                  key={chip.key}
                  className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-line bg-mist/70 px-2.5 text-xs font-semibold text-stone-700"
                >
                  <span className="truncate">{chip.label}</span>
                  <button
                    type="button"
                    onClick={chip.onRemove}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-stone-500 transition hover:bg-white hover:text-ink"
                    title={`Remove ${chip.label}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
              <button
                type="button"
                onClick={clearAllFilters}
                className="h-8 px-2 text-xs font-bold text-stone-500 transition hover:text-ink"
              >
                Clear filters
              </button>
            </div>
          ) : null}
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
              onMove={onMove}
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

function getOptionLabel<T extends string>(options: Array<{ id: T; label: string }>, id: T) {
  return options.find((option) => option.id === id)?.label ?? id;
}

function getResultCountLabel({
  visibleCount,
  loadedCount,
  totalCount,
  hasMoreJobs,
  isLoadingMoreJobs,
}: {
  visibleCount: number;
  loadedCount: number;
  totalCount?: number;
  hasMoreJobs: boolean;
  isLoadingMoreJobs: boolean;
}) {
  if (isLoadingMoreJobs) return "Loading more...";
  const knownTotal = typeof totalCount === "number" ? totalCount : loadedCount;
  if (hasMoreJobs || loadedCount < knownTotal) return `Showing ${visibleCount} of ${knownTotal}`;
  return `${visibleCount} ${visibleCount === 1 ? "job" : "jobs"}`;
}

function compareJobs(a: Job, b: Job, sortMode: SortMode) {
  if (sortMode === "oldest") return dateValue(a.createdAt) - dateValue(b.createdAt);
  if (sortMode === "recent_completed") {
    return byNumberDesc(dateValue(a.completedAt), dateValue(b.completedAt)) || byNewest(a, b);
  }
  if (sortMode === "credits_desc") {
    return byNumberDesc(a.creditsUsed, b.creditsUsed) || byNewest(a, b);
  }
  if (sortMode === "credits_asc") {
    return byNumberAsc(a.creditsUsed, b.creditsUsed) || byNewest(a, b);
  }
  if (sortMode === "generation_desc") {
    return byNumberDesc(parseDurationMs(a.generationTime), parseDurationMs(b.generationTime)) || byNewest(a, b);
  }
  return byNewest(a, b);
}

function byNewest(a: Job, b: Job) {
  return dateValue(b.createdAt) - dateValue(a.createdAt);
}

function byNumberDesc(a: number | undefined, b: number | undefined) {
  return finiteNumber(b) - finiteNumber(a);
}

function byNumberAsc(a: number | undefined, b: number | undefined) {
  return finiteNumber(a) - finiteNumber(b);
}

function finiteNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dateValue(date: string | undefined) {
  if (!date) return 0;
  const value = new Date(date).getTime();
  return Number.isFinite(value) ? value : 0;
}

function parseDurationMs(value: string | undefined) {
  if (!value) return 0;
  const normalized = value.trim().toLowerCase();
  const colonParts = normalized.split(":").map(Number);
  if (colonParts.length > 1 && colonParts.every(Number.isFinite)) {
    return colonParts.reduce((total, part) => total * 60 + part, 0) * 1000;
  }

  let seconds = 0;
  const hourMatch = normalized.match(/([\d.]+)\s*(?:h|hr|hour|hours)/);
  const minuteMatch = normalized.match(/([\d.]+)\s*(?:m|min|minute|minutes)/);
  const secondMatch = normalized.match(/([\d.]+)\s*(?:s|sec|second|seconds)/);
  if (hourMatch) seconds += Number(hourMatch[1]) * 60 * 60;
  if (minuteMatch) seconds += Number(minuteMatch[1]) * 60;
  if (secondMatch) seconds += Number(secondMatch[1]);
  if (seconds > 0) return seconds * 1000;

  const numeric = Number(normalized.replace(/[^\d.]/g, ""));
  return Number.isFinite(numeric) ? numeric * 1000 : 0;
}

function isWithinDays(date: string, days: number) {
  const now = Date.now();
  const target = new Date(date).getTime();
  return Number.isFinite(target) && now - target <= days * 24 * 60 * 60 * 1000;
}

function matchesSelectedFolder(job: Job, selectedFolderId: "all" | "root" | string) {
  if (selectedFolderId === "all") return true;
  if (selectedFolderId === "root") return !job.folderId;
  return job.folderId === selectedFolderId;
}

function hasJobSaveNumber(job: Job) {
  return Boolean(job.workflowOptions?.save?.cameraNumber || job.workflowOptions?.save?.shotNumber);
}
