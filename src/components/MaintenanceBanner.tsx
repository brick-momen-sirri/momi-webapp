import { Wrench } from "lucide-react";

type MaintenanceBannerProps = {
  message?: string;
};

/**
 * Shown to everyone while generation is paused for an update.
 *
 * Sits above the workspace switch, so it is in view from both Animation and Still
 * Images, right where the Generate button it explains lives. It goes away on its
 * own: the page reads the switch on every poll.
 */
export function MaintenanceBanner({ message }: MaintenanceBannerProps) {
  if (!message) return null;
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-900 shadow-panel"
    >
      <Wrench className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-semibold leading-5">{message}</p>
        <p className="mt-0.5 text-xs leading-5 text-amber-800">
          Generate is paused for everyone until it finishes. Jobs already running are not affected.
        </p>
      </div>
    </div>
  );
}
