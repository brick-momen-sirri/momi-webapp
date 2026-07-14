import { Activity, ExternalLink, MonitorCog, Play, RefreshCw, RotateCcw, Settings, Square, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { ComfyPoolAction, ComfyPoolActionResult, ComfyServer } from "../services/backendApi";

type ComfyPoolManagerProps = {
  servers: ComfyServer[];
  canManage: boolean;
  onRefresh: () => Promise<void>;
  onAction: (action: ComfyPoolAction, port?: number) => Promise<ComfyPoolActionResult>;
};

export function ComfyPoolManager({ servers, canManage, onRefresh, onAction }: ComfyPoolManagerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedPort, setSelectedPort] = useState<number | undefined>();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pendingMessage, setPendingMessage] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionDetail, setActionDetail] = useState("");
  const [watchedPort, setWatchedPort] = useState<number | undefined>();

  const sortedServers = useMemo(() => [...servers].sort((a, b) => serverPort(a) - serverPort(b)), [servers]);
  const selectedServer = sortedServers.find((server) => serverPort(server) === selectedPort) ?? sortedServers[0];
  const runningCount = servers.filter((server) => server.status === "idle" || server.status === "busy").length;
  const busyCount = servers.filter((server) => server.status === "busy").length;

  useEffect(() => {
    if (watchedPort == null) {
      return;
    }

    const watchedServer = servers.find((server) => serverPort(server) === watchedPort);
    if (watchedServer?.status === "idle" || watchedServer?.status === "busy") {
      setPendingMessage("");
      setActionMessage(`Instance ${watchedPort} is ${watchedServer.status}.`);
      setWatchedPort(undefined);
    }
  }, [servers, watchedPort]);

  async function run(label: string, action: ComfyPoolAction, port?: number) {
    if (!canManage) {
      setError("Admin access is required.");
      return;
    }

    setBusyAction(label);
    setError("");
    setPendingMessage("");
    setActionMessage(`Sending ${label} command...`);
    setActionDetail("");
    setWatchedPort(undefined);
    try {
      const result = await onAction(action, port);
      setActionMessage(result.message);
      setActionDetail(formatActionDetail(result));
      scheduleFollowUpRefreshes(action, port);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Could not manage the Comfy pool.");
      setPendingMessage("");
      setActionMessage("");
      setActionDetail("");
    } finally {
      setBusyAction(null);
    }
  }

  async function refresh() {
    setBusyAction("refresh");
    setError("");
    setActionMessage("");
    setActionDetail("");
    try {
      await onRefresh();
      setPendingMessage("");
      setActionMessage("Status refreshed.");
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Could not refresh the Comfy pool.");
    } finally {
      setBusyAction(null);
    }
  }

  function scheduleFollowUpRefreshes(action: ComfyPoolAction, port?: number) {
    const delays = refreshDelaysForAction(action);
    if (!delays.length) {
      return;
    }

    if (action === "start" || action === "restart" || action === "start-safe" || action === "start-all") {
      setPendingMessage("Waiting for Comfy to come online...");
      setWatchedPort(port);
    }

    delays.forEach((delay, index) => {
      window.setTimeout(() => {
        void onRefresh()
          .then(() => {
            if (index === delays.length - 1) {
              setPendingMessage("");
              setWatchedPort(undefined);
            }
          })
          .catch(() => {
            if (index === delays.length - 1) {
              setPendingMessage("");
              setWatchedPort(undefined);
              setError("Could not refresh pool status. Try the refresh button.");
            }
          });
      }, delay);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="fixed right-4 top-4 z-[900] flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-white text-ink shadow-panel transition hover:border-accent hover:text-accent"
        title="Comfy pool settings"
      >
        <Settings className="h-5 w-5" />
      </button>

      {isOpen ? (
        <div className="fixed inset-0 z-[1000] bg-ink/35 p-3 backdrop-blur-sm" role="dialog" aria-modal="true">
          <div className="ml-auto flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-line bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-bold text-ink">
                  <MonitorCog className="h-4 w-4 text-accent" />
                  Comfy pool
                </div>
                <p className="mt-0.5 text-xs font-semibold text-stone-500">
                  {runningCount}/{servers.length} running, {busyCount} busy
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={refresh}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-stone-600 transition hover:bg-mist"
                  title="Refresh"
                >
                  <RefreshCw className={`h-4 w-4 ${busyAction === "refresh" ? "animate-spin" : ""}`} />
                </button>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-stone-600 transition hover:bg-mist"
                  title="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[minmax(0,1fr)_260px]">
              <div className="scrollbar-thin min-h-0 overflow-y-auto border-b border-line md:border-b-0 md:border-r">
                <table className="w-full table-fixed text-left text-xs">
                  <thead className="sticky top-0 bg-mist text-[11px] uppercase text-stone-500">
                    <tr>
                      <th className="w-20 px-3 py-2 font-bold">Port</th>
                      <th className="w-28 px-3 py-2 font-bold">Status</th>
                      <th className="px-3 py-2 font-bold">URL</th>
                      <th className="w-28 px-3 py-2 font-bold">Checked</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {sortedServers.map((server) => {
                      const port = serverPort(server);
                      const selected = selectedServer && port === serverPort(selectedServer);
                      return (
                        <tr
                          key={server.url}
                          onClick={() => setSelectedPort(port)}
                          className={`cursor-pointer transition hover:bg-mist/70 ${selected ? "bg-accent/10" : ""}`}
                        >
                          <td className="px-3 py-2 font-bold text-ink">{port}</td>
                          <td className="px-3 py-2">
                            <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-bold ${statusClass(server.status)}`}>
                              <span className="h-1.5 w-1.5 rounded-full bg-current" />
                              {server.status}
                            </span>
                          </td>
                          <td className="truncate px-3 py-2 font-semibold text-stone-600">{server.url}</td>
                          <td className="truncate px-3 py-2 text-stone-500">{formatCheckedAt(server.lastChecked)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="scrollbar-thin min-h-0 overflow-y-auto p-4">
                <div className="space-y-4">
                  <section>
                    <div className="mb-2 flex items-center gap-2 text-sm font-bold text-ink">
                      <Activity className="h-4 w-4 text-accent" />
                      Instance {selectedServer ? serverPort(selectedServer) : ""}
                    </div>
                    {selectedServer ? (
                      <div className="space-y-2 text-xs font-semibold text-stone-600">
                        <p className="truncate">{selectedServer.url}</p>
                        {selectedServer.errorMessage ? <p className="text-red-600">{selectedServer.errorMessage}</p> : null}
                        <div className="grid grid-cols-3 gap-2">
                          <IconButton
                            icon={<Play className="h-4 w-4" />}
                            label="Start"
                            disabled={!canManage || Boolean(busyAction)}
                            onClick={() => run("start", "start", serverPort(selectedServer))}
                          />
                          <IconButton
                            icon={<Square className="h-4 w-4" />}
                            label="Stop"
                            disabled={!canManage || Boolean(busyAction)}
                            onClick={() => run("stop", "stop", serverPort(selectedServer))}
                          />
                          <IconButton
                            icon={<RotateCcw className="h-4 w-4" />}
                            label="Restart"
                            disabled={!canManage || Boolean(busyAction)}
                            onClick={() => run("restart", "restart", serverPort(selectedServer))}
                          />
                        </div>
                        <a
                          className="flex h-9 items-center justify-center gap-2 rounded-md border border-line text-xs font-bold text-ink transition hover:border-accent hover:text-accent"
                          href={selectedServer.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <ExternalLink className="h-4 w-4" />
                          Open UI
                        </a>
                      </div>
                    ) : (
                      <p className="text-xs font-semibold text-stone-500">No instances found.</p>
                    )}
                  </section>

                  <section className="space-y-2">
                    <p className="text-sm font-bold text-ink">Pool</p>
                    <ActionButton disabled={!canManage || Boolean(busyAction)} onClick={() => run("start-safe", "start-safe")}>
                      Start 4
                    </ActionButton>
                    <ActionButton disabled={!canManage || Boolean(busyAction)} onClick={() => run("start-all", "start-all")}>
                      Start all
                    </ActionButton>
                    <ActionButton disabled={!canManage || Boolean(busyAction)} onClick={() => run("stop-all", "stop-all")}>
                      Stop all
                    </ActionButton>
                    <ActionButton disabled={!canManage || Boolean(busyAction)} onClick={() => run("open-manager", "open-manager")}>
                      Open desktop manager
                    </ActionButton>
                  </section>

                  {!canManage ? <p className="text-xs font-semibold text-stone-500">Admin access is required.</p> : null}
                  {busyAction && busyAction !== "refresh" ? <p className="text-xs font-semibold text-accent">Running {busyAction}...</p> : null}
                  {actionMessage ? <p className="text-xs font-semibold text-stone-600">{actionMessage}</p> : null}
                  {actionDetail ? (
                    <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-mist/80 p-2 text-[11px] font-semibold leading-5 text-stone-600">
                      {actionDetail}
                    </pre>
                  ) : null}
                  {pendingMessage ? <p className="text-xs font-semibold text-accent">{pendingMessage}</p> : null}
                  {error ? <p className="text-xs font-semibold text-red-600">{error}</p> : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function IconButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-9 items-center justify-center rounded-md border border-line text-ink transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
      title={label}
    >
      {icon}
    </button>
  );
}

function ActionButton({ children, disabled, onClick }: { children: ReactNode; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-9 w-full items-center justify-center rounded-md border border-line px-3 text-xs font-bold text-ink transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
    >
      {children}
    </button>
  );
}

function serverPort(server: ComfyServer) {
  if (typeof server.port === "number") return server.port;
  try {
    return Number(new URL(server.url).port);
  } catch {
    return 0;
  }
}

function statusClass(status: ComfyServer["status"]) {
  if (status === "idle") return "bg-emerald-50 text-emerald-700";
  if (status === "busy") return "bg-amber-50 text-amber-700";
  if (status === "error") return "bg-red-50 text-red-700";
  return "bg-stone-100 text-stone-500";
}

function refreshDelaysForAction(action: ComfyPoolAction) {
  if (action === "open-manager") return [1200];
  if (action === "stop" || action === "stop-all") return [800, 2500, 5000];
  return [1200, 5000, 15000, 30000, 60000, 120000];
}

function formatActionDetail(result: ComfyPoolActionResult) {
  const detail = [result.output, result.errorOutput].filter(Boolean).join("\n").trim();
  if (!detail) return "";
  const lines = detail.split(/\r?\n/).filter(Boolean);
  return lines.slice(-8).join("\n");
}

function formatCheckedAt(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}
