import { Volume2 } from "lucide-react";

type SeedanceAudioControlProps = {
  value: boolean;
  onChange: (value: boolean) => void;
};

/**
 * Seedance's "generate an audio track" switch.
 *
 * Every Seedance version and task declares `generate_audio`, and the node defaults
 * it to true, so before this switch existed every render came back with a track
 * nobody had asked for. That is not free: the provider runs a copyright check on
 * the audio it generated, and a match fails the whole job -- with the video already
 * rendered and billed -- reported only as "Job processing failed". Seventeen jobs
 * were lost that way before the switch existed.
 *
 * Hence off by default, and worth a visible control rather than a hidden constant:
 * the artist who does want sound needs a way to ask for it, and the one who does
 * not should be able to see that they are not paying for the risk.
 */
export function SeedanceAudioControl({ value, onChange }: SeedanceAudioControlProps) {
  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          name="seedance_generate_audio"
          checked={value}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-accent"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Volume2 className="h-4 w-4 text-stone-500" />
            Generate sound
          </span>
          <span className="mt-1 block text-xs leading-5 text-stone-600">
            {value
              ? "The model adds an audio track. If the provider's copyright check rejects that track the whole render fails, even though the video itself was fine."
              : "Off: silent video. Recommended — the audio is generated, not recorded, and a copyright match on it fails the entire render."}
          </span>
        </span>
      </label>
    </section>
  );
}
