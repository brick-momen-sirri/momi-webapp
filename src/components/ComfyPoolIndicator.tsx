import { Activity, Circle, Power } from "lucide-react";
import type { ReactNode } from "react";
import type { ComfyServer } from "../services/backendApi";

type ComfyPoolIndicatorProps = {
  servers: ComfyServer[];
};

export function ComfyPoolIndicator({ servers }: ComfyPoolIndicatorProps) {
  const running = servers.filter((server) => server.status === "idle" || server.status === "busy").length;
  const idle = servers.filter((server) => server.status === "idle").length;
  const stopped = servers.filter((server) => server.status === "offline" || server.status === "error").length;

  return (
    <section className="rounded-lg border border-line bg-white px-3 py-2 shadow-panel">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-bold text-ink">
          <Activity className="h-3.5 w-3.5 text-accent" />
          Comfy pool
        </div>
        <span className="text-[11px] font-semibold text-stone-500">{servers.length} total</span>
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-[11px] font-semibold">
        <PoolStat icon={<Circle className="h-2.5 w-2.5 fill-emerald-500 text-emerald-500" />} label="Running" value={running} />
        <PoolStat icon={<Circle className="h-2.5 w-2.5 fill-accent text-accent" />} label="Idle" value={idle} />
        <PoolStat icon={<Power className="h-3 w-3 text-stone-400" />} label="Stopped" value={stopped} />
      </div>
    </section>
  );
}

function PoolStat({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-md bg-mist/70 px-2 py-1.5">
      <div className="flex items-center gap-1 text-stone-500">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <p className="mt-0.5 text-sm font-bold text-ink">{value}</p>
    </div>
  );
}
