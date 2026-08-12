import { Hash } from "lucide-react";

type ResultNamingControlProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
};

export function ResultNamingControl({ label, value, onChange }: ResultNamingControlProps) {
  function handleChange(nextValue: string) {
    onChange(nextValue.replace(/\D/g, "").slice(0, 4));
  }

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <label className="block">
        <span className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
          <Hash className="h-3.5 w-3.5 text-accent" />
          {label}
        </span>
        <input
          type="text"
          inputMode="numeric"
          value={value}
          placeholder="0000"
          aria-label={label}
          onBlur={() => {
            if (!value.trim()) onChange("0000");
          }}
          onChange={(event) => handleChange(event.target.value)}
          className="h-10 w-full rounded-md border border-line bg-white px-3 text-sm font-semibold text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
      </label>
    </section>
  );
}
