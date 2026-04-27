import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "@/lib/theme-context";

type Variant = "default" | "overlay";

const NEXT: Record<"light" | "dark" | "system", "light" | "dark" | "system"> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const LABELS: Record<"light" | "dark" | "system", string> = {
  light: "Switch to dark theme",
  dark: "Switch to follow system theme",
  system: "Switch to light theme",
};

export function ThemeToggle({ variant = "default" }: { variant?: Variant }) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  const Icon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;

  const styles =
    variant === "overlay"
      ? isDark
        ? "bg-black/40 backdrop-blur-md border-white/10 hover:bg-black/60 text-white"
        : "bg-[#fff5d8]/75 backdrop-blur-md border-stone-400/55 hover:bg-[#fff5d8]/85 text-stone-900"
      : isDark
        ? "bg-white/5 border-white/10 hover:bg-white/10 text-white"
        : "bg-stone-300/35 border-stone-400/55 hover:bg-stone-300/55 text-stone-900";

  return (
    <button
      type="button"
      onClick={() => setTheme(NEXT[theme])}
      aria-label={LABELS[theme]}
      title={`Theme: ${theme}`}
      data-testid="theme-toggle"
      className={`h-10 w-10 rounded-full flex items-center justify-center border transition-colors shrink-0 ${styles}`}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}
