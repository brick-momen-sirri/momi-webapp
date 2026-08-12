import { Film, Images } from "lucide-react";
import { cn } from "../utils/classNames";

export type MainSection = "animation" | "still-images";

type MainSectionNavigationProps = {
  value: MainSection;
  onChange: (section: MainSection) => void;
};

const sections = [
  { id: "animation", label: "Animation", hint: "Video generation", icon: Film },
  { id: "still-images", label: "Still Images", hint: "Image workflows", icon: Images },
] as const;

export function MainSectionNavigation({ value, onChange }: MainSectionNavigationProps) {
  return (
    <nav aria-label="Main sections" className="rounded-lg border border-line bg-white p-3 shadow-panel">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">Workspace</p>
      <div className="grid grid-cols-2 gap-2">
        {sections.map((section) => {
          const Icon = section.icon;
          const selected = value === section.id;

          return (
            <button
              key={section.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(section.id)}
              className={cn(
                "flex min-h-[58px] items-center gap-2 rounded-md border px-2.5 py-2 text-left transition",
                selected
                  ? "border-accent bg-accent text-white shadow-card"
                  : "border-line bg-white text-stone-700 hover:border-accent hover:bg-mist",
              )}
            >
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border",
                  selected ? "border-white/25 bg-white/15" : "border-line bg-stone-50 text-stone-600",
                )}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-bold">{section.label}</span>
                <span className={cn("mt-0.5 block truncate text-[11px]", selected ? "text-white/75" : "text-stone-500")}>
                  {section.hint}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
