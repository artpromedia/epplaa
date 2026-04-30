import { cn } from "@/lib/utils";

const STYLE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300",
  review: "bg-blue-100 text-blue-900 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300",
  approved: "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300",
  active: "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300",
  paid: "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300",
  delivered: "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300",
  released: "bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300",
  rejected: "bg-rose-100 text-rose-900 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300",
  failed: "bg-rose-100 text-rose-900 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300",
  suspended: "bg-rose-100 text-rose-900 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300",
  draft: "bg-muted text-muted-foreground border-border",
  paused: "bg-muted text-muted-foreground border-border",
  none: "bg-muted text-muted-foreground border-border",
  booked: "bg-blue-100 text-blue-900 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300",
  in_transit: "bg-indigo-100 text-indigo-900 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300",
  at_customs: "bg-purple-100 text-purple-900 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300",
  arrived: "bg-teal-100 text-teal-900 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300",
};

export function StatusBadge({ value }: { value: string | null | undefined }) {
  const v = String(value ?? "—").toLowerCase();
  const cls = STYLE[v] ?? "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border",
        cls,
      )}
    >
      {String(value ?? "—").replace(/_/g, " ")}
    </span>
  );
}
