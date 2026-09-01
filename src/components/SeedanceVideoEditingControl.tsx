import { Scissors } from "lucide-react";

type SeedanceVideoEditingControlProps = {
  value: boolean;
  onChange: (value: boolean) => void;
};

/**
 * Seedance 2.5's "edit the source clip" switch.
 *
 * 2.5 only, and only where a video is an input -- LeftSettingsPanel decides that.
 * Worth its own control rather than a hidden default because the two modes produce
 * different things from the same inputs: with it on the node edits the connected
 * clip and keeps that clip's length and aspect, so the duration and ratio pickers
 * stop applying. Saying so here is cheaper than having someone work it out from a
 * result that ignored the duration they set.
 */
export function SeedanceVideoEditingControl({ value, onChange }: SeedanceVideoEditingControlProps) {
  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          name="seedance_video_editing"
          checked={value}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-accent"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Scissors className="h-4 w-4 text-stone-500" />
            Edit the source video
          </span>
          <span className="mt-1 block text-xs leading-5 text-stone-600">
            {value
              ? "The prompt edits the uploaded clip. The result keeps that clip's length and aspect ratio, so Duration and Aspect ratio are ignored."
              : "Off: generate a new video from the clip as a reference, at the duration and aspect ratio set above."}
          </span>
        </span>
      </label>
    </section>
  );
}
