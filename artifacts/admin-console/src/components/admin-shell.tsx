import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useUser, UserButton } from "@clerk/clerk-react";
import {
  LayoutDashboard,
  Inbox,
  Scale,
  Wallet,
  Ban,
  Users,
  TestTube2,
} from "lucide-react";
import { useAdminMyRoles } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import epplaaLogo from "@assets/epplaa-logo-color-nobg.png";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/cases", label: "Cases", icon: Inbox },
  { href: "/disputes", label: "Disputes", icon: Scale },
  { href: "/payouts", label: "Payouts", icon: Wallet },
  { href: "/takedowns", label: "Takedowns", icon: Ban },
  { href: "/users", label: "Users & roles", icon: Users },
  { href: "/scan", label: "Scan bench", icon: TestTube2 },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { user } = useUser();
  const rolesQuery = useAdminMyRoles({
    query: { staleTime: 30_000 } as never,
  });
  const roles = rolesQuery.data?.roles ?? [];

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      <aside className="hidden md:flex md:w-60 lg:w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="px-4 py-4 border-b border-sidebar-border flex items-center gap-3">
          <img
            src={epplaaLogo}
            alt="Epplaa"
            className="h-7 w-auto"
            data-testid="img-brand-logo"
          />
          <div className="leading-tight border-l border-sidebar-border pl-3">
            <p className="text-xs font-semibold">Admin</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Trust &amp; Safety
            </p>
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {NAV.map((item) => {
            const active =
              item.href === "/"
                ? location === "/" || location === ""
                : location.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 rounded-md text-sm hover-elevate",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground/80",
                )}
              >
                <Icon className="w-4 h-4" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-sidebar-border">
          <div className="flex items-center gap-2 mb-2">
            <UserButton afterSignOutUrl="/sign-in" />
            <div className="min-w-0 leading-tight">
              <p className="text-xs font-medium truncate">
                {user?.primaryEmailAddress?.emailAddress ?? user?.id ?? "Operator"}
              </p>
              <p className="text-[10px] text-muted-foreground truncate">
                {roles.length === 0
                  ? rolesQuery.isLoading
                    ? "Loading roles…"
                    : "No roles"
                  : roles.join(" · ")}
              </p>
            </div>
          </div>
          {roles.length === 0 && !rolesQuery.isLoading && (
            <p className="text-[10px] text-destructive">
              You have no admin roles. Ask an admin to grant you access.
            </p>
          )}
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="md:hidden border-b border-border bg-background px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src={epplaaLogo} alt="Epplaa" className="h-5 w-auto" />
            <span className="text-xs font-semibold text-muted-foreground border-l border-border pl-2">Admin</span>
          </div>
          <UserButton afterSignOutUrl="/sign-in" />
        </header>

        <main className="flex-1 min-w-0 overflow-x-auto">
          <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-7xl mx-auto w-full">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
