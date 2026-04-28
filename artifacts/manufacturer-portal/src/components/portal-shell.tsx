import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useUser, UserButton } from "@clerk/clerk-react";
import {
  Factory,
  LayoutDashboard,
  FileCheck2,
  Boxes,
  PackageSearch,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import epplaaLogo from "@assets/epplaa-logo-color_1777409658028.png";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/apply", label: "Application", icon: Factory },
  { href: "/kyc", label: "KYC documents", icon: FileCheck2 },
  { href: "/listings", label: "Wholesale catalog", icon: Boxes },
  { href: "/orders", label: "Orders", icon: PackageSearch },
  { href: "/payouts", label: "Payouts", icon: Wallet },
];

export function PortalShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { user } = useUser();

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
            <p className="text-xs font-semibold">Manufacturers</p>
            <p className="text-[10px] uppercase tracking-wider text-sidebar-foreground/60">
              Cross-border supply
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
          <div className="flex items-center gap-2">
            <UserButton afterSignOutUrl="/sign-in" />
            <div className="min-w-0 leading-tight">
              <p className="text-xs font-medium truncate">
                {user?.primaryEmailAddress?.emailAddress ?? user?.id ?? "Manufacturer"}
              </p>
              <p className="text-[10px] text-sidebar-foreground/60 truncate">
                Supplier portal
              </p>
            </div>
          </div>
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        <div className="md:hidden border-b border-border bg-card px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src={epplaaLogo} alt="Epplaa" className="h-5 w-auto" />
            <span className="text-xs font-semibold text-muted-foreground border-l border-border pl-2">Manufacturers</span>
          </div>
          <UserButton afterSignOutUrl="/sign-in" />
        </div>
        <div className="md:hidden border-b border-border bg-card px-2 py-1 flex gap-1 overflow-x-auto">
          {NAV.map((item) => {
            const active =
              item.href === "/"
                ? location === "/" || location === ""
                : location.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs whitespace-nowrap hover-elevate",
                  active
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
        <div className="p-4 md:p-6 lg:p-8">{children}</div>
      </main>
    </div>
  );
}
