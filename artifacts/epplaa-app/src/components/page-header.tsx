import { ChevronLeft } from "lucide-react";
import { Link } from "wouter";
import { useTheme } from "@/lib/theme-context";
import { ThemeToggle } from "@/components/theme-toggle";

export function PageHeader({
  title,
  backHref = "/profile",
}: {
  title: string;
  backHref?: string;
}) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  return (
    <div
      className={`pt-12 pb-4 px-4 z-10 sticky top-0 ${
        isDark ? "bg-[#050505]" : "bg-[#fbeed3]"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Link
            href={backHref}
            className={`flex items-center justify-center w-9 h-9 -ml-2 rounded-full ${
              isDark
                ? "hover:bg-white/10 text-white"
                : "hover:bg-stone-200 text-stone-900"
            }`}
            aria-label="Back"
          >
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <h1 className="text-xl font-bold truncate">{title}</h1>
        </div>
        <ThemeToggle />
      </div>
    </div>
  );
}
