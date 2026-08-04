import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import { fallbackModelCatalog } from "../../data/modelCatalog";
import { emptyJobs, emptyProjects } from "../../data/productionDefaults";
import {
  clearStoredAuthToken,
  fetchBackendCredits,
  fetchBackendJobs,
  fetchBackendModels,
  fetchBackendMonthlyUsage,
  fetchBackendProjects,
  fetchBackendRuntime,
  fetchBackendSnapshot,
  fetchBackendUsers,
  fetchComfyServers,
  fetchPodStatus,
  runComfyPoolAction,
  type AuthUser,
  type BackendJobsPage,
  type BackendRuntime,
  type ComfyPoolAction,
  type ComfyPoolActionResult,
  type ComfyServer,
  type PodStatusResponse,
} from "../../services/backendApi";
import type { Job, Project } from "../../types";
import { useResetWhenChanged } from "../../utils/useResetWhenChanged";
import { ALL_PROJECTS_ID, jobPageParams, mapMonthlyUsageByUser, mergeJobs } from "./workspaceUtils";

type ShowToast = (message: string, type?: "success" | "error" | "info") => void;

type WorkspaceDataOptions = {
  account: AuthUser | null;
  setAccount: Dispatch<SetStateAction<AuthUser | null>>;
  setWorkspaceAccounts: Dispatch<SetStateAction<AuthUser[]>>;
  selectedProjectId: string;
  setSelectedProjectId: Dispatch<SetStateAction<string>>;
  selectedFolderId: string;
  showToast: ShowToast;
};

export function useWorkspaceData(options: WorkspaceDataOptions) {
  const { account, setAccount, setWorkspaceAccounts, selectedProjectId, setSelectedProjectId, selectedFolderId, showToast } =
    options;
  const [projects, setProjects] = useState<Project[]>(emptyProjects);
  const [jobs, setJobs] = useState<Job[]>(emptyJobs);
  const [backendJobsTotal, setBackendJobsTotal] = useState(0);
  const [backendJobsOffset, setBackendJobsOffset] = useState(0);
  const [isLoadingMoreJobs, setIsLoadingMoreJobs] = useState(false);
  const [showArchivedJobs, setShowArchivedJobs] = useState(false);
  const [models, setModels] = useState(fallbackModelCatalog);
  const [backendCreditsRemaining, setBackendCreditsRemaining] = useState<number | null>(null);
  const [monthlyUsageByUser, setMonthlyUsageByUser] = useState<Record<string, { creditsSpent: number; jobsCompleted: number }>>(
    {},
  );
  const [backendRuntime, setBackendRuntime] = useState<BackendRuntime>();
  const [comfyServers, setComfyServers] = useState<ComfyServer[]>([]);
  const [podStatus, setPodStatus] = useState<PodStatusResponse>();
  const [backendAvailable, setBackendAvailable] = useState(false);
  const [loadedWorkspaceAccountId, setLoadedWorkspaceAccountId] = useState<string | null>(null);

  useResetWhenChanged(account?.id ?? null, () => {
    if (!account) {
      setLoadedWorkspaceAccountId(null);
      setPodStatus(undefined);
    }
  });

  useEffect(() => {
    if (!account) return;
    const accountId = account.id;
    let mounted = true;

    async function loadBackendData() {
      let shouldMarkWorkspaceLoaded = true;
      try {
        const [backendModels, backendProjects, backendJobsPage, credits, monthlyUsage, backendUsers, runtime] = await Promise.all(
          [
            fetchBackendModels(),
            fetchBackendProjects(),
            fetchBackendJobs(jobPageParams(selectedProjectId, selectedFolderId, 0, showArchivedJobs)),
            fetchBackendCredits(),
            fetchBackendMonthlyUsage(),
            fetchBackendUsers(),
            fetchBackendRuntime(),
          ],
        );
        const servers = runtime.localComfyEnabled ? await fetchComfyServers() : [];
        if (!mounted) return;
        setBackendAvailable(true);
        setBackendRuntime(runtime);
        if (backendModels.length) {
          setModels(backendModels);
        }
        if (backendProjects.length) {
          setProjects(backendProjects);
          setSelectedProjectId((current) =>
            current === ALL_PROJECTS_ID || backendProjects.some((project) => project.id === current) ? current : ALL_PROJECTS_ID,
          );
        }
        applyBackendJobsPage(backendJobsPage, true);
        if (typeof credits.creditsLeft === "number") setBackendCreditsRemaining(Math.floor(credits.creditsLeft));
        setMonthlyUsageByUser(mapMonthlyUsageByUser(monthlyUsage.users));
        setComfyServers(servers);
        setWorkspaceAccounts(backendUsers);
        void fetchPodStatus()
          .then((status) => {
            if (mounted) setPodStatus(status);
          })
          .catch(() => undefined);
      } catch (error) {
        if (!mounted) return;
        if (error instanceof Error && error.message.includes("Authentication required")) {
          shouldMarkWorkspaceLoaded = false;
          clearStoredAuthToken();
          setAccount(null);
          setLoadedWorkspaceAccountId(null);
          return;
        }
        setBackendAvailable(false);
      } finally {
        if (mounted && shouldMarkWorkspaceLoaded) setLoadedWorkspaceAccountId(accountId);
      }
    }

    void loadBackendData();
    let tick = 0;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      tick += 1;
      void fetchBackendJobs(jobPageParams(selectedProjectId, selectedFolderId, 0, showArchivedJobs))
        .then((page) => {
          if (!mounted) return;
          setBackendAvailable(true);
          applyBackendJobsPage(page);
        })
        .catch(() => setBackendAvailable(false));
      void fetchBackendSnapshot()
        .then((snapshot) => {
          if (!mounted) return;
          if (snapshot.credits && typeof snapshot.credits.creditsLeft === "number") {
            setBackendCreditsRemaining(Math.floor(snapshot.credits.creditsLeft));
          }
          setMonthlyUsageByUser(mapMonthlyUsageByUser(snapshot.monthlyUsage.users));
          setBackendRuntime(snapshot.runtime);
          if (!snapshot.runtime.localComfyEnabled) setComfyServers([]);
          if (snapshot.runtime.localComfyEnabled) {
            void fetchComfyServers()
              .then((servers) => {
                if (mounted) setComfyServers(servers);
              })
              .catch(() => undefined);
          }
          if (snapshot.podStatus) setPodStatus(snapshot.podStatus);
        })
        .catch(() => undefined);
      if (tick % 3 === 0) {
        void fetchBackendUsers()
          .then((users) => {
            if (mounted) setWorkspaceAccounts(users);
          })
          .catch(() => undefined);
        void fetchBackendProjects()
          .then((backendProjects) => {
            if (!mounted) return;
            setProjects(backendProjects);
            setSelectedProjectId((current) =>
              current === ALL_PROJECTS_ID || backendProjects.some((project) => project.id === current)
                ? current
                : ALL_PROJECTS_ID,
            );
          })
          .catch(() => undefined);
      }
    }, 12000);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [account, selectedFolderId, selectedProjectId, setAccount, setSelectedProjectId, setWorkspaceAccounts, showArchivedJobs]);

  function applyBackendJobsPage(page: BackendJobsPage, reset = false) {
    setJobs((current) => (reset ? page.jobs : mergeJobs(page.jobs, current)));
    setBackendJobsTotal(page.total);
    setBackendJobsOffset((current) => {
      const pageEnd = page.offset + page.jobs.length;
      return reset ? pageEnd : Math.max(current, pageEnd);
    });
  }

  async function refreshComfyServers() {
    if (!backendRuntime?.localComfyEnabled) {
      setComfyServers([]);
      return;
    }
    setComfyServers(await fetchComfyServers());
  }

  async function handleComfyPoolAction(action: ComfyPoolAction, port?: number): Promise<ComfyPoolActionResult> {
    const result = await runComfyPoolAction(action, port);
    showToast(result.message);
    void refreshComfyServers().catch(() => undefined);
    return result;
  }

  async function handleLoadMoreJobs() {
    if (!backendAvailable || isLoadingMoreJobs) return;
    setIsLoadingMoreJobs(true);
    try {
      const page = await fetchBackendJobs(
        jobPageParams(selectedProjectId, selectedFolderId, backendJobsOffset, showArchivedJobs),
      );
      applyBackendJobsPage(page);
      showToast(page.jobs.length ? `Loaded ${page.jobs.length} more jobs.` : "No more jobs to load.");
    } catch {
      setBackendAvailable(false);
      showToast("Could not load more jobs from the backend.", "error");
    } finally {
      setIsLoadingMoreJobs(false);
    }
  }

  function handleToggleArchivedView() {
    setShowArchivedJobs((current) => !current);
    setJobs([]);
    setBackendJobsOffset(0);
    setBackendJobsTotal(0);
  }

  return {
    projects,
    setProjects,
    jobs,
    setJobs,
    backendJobsTotal,
    setBackendJobsTotal,
    backendJobsOffset,
    setBackendJobsOffset,
    isLoadingMoreJobs,
    showArchivedJobs,
    models,
    backendCreditsRemaining,
    monthlyUsageByUser,
    backendRuntime,
    comfyServers,
    podStatus,
    backendAvailable,
    setBackendAvailable,
    loadedWorkspaceAccountId,
    refreshComfyServers,
    handleComfyPoolAction,
    handleLoadMoreJobs,
    handleToggleArchivedView,
  };
}
