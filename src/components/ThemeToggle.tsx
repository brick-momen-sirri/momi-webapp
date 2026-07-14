import { Moon, Sun } from "lucide-react";

export type ThemeMode = "light" | "dark";

type ThemeToggleProps = {
  theme: ThemeMode;
  onToggle: () => void;
};

export function ThemeToggle({ theme, onToggle }: ThemeToggleProps) {
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={onToggle}
      className="theme-toggle inline-flex h-7 w-7 items-center justify-center rounded-md border border-line bg-white text-stone-500 transition hover:border-accent hover:bg-stone-50 hover:text-accent"
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={isDark}
    >
      {isDark ? <Sun className="h-3 w-3" /> : <Moon className="h-3 w-3" />}
    </button>
  );
}
