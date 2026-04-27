import {
  Home,
  Compass,
  Plus,
  MessageSquare,
  User,
  LayoutGrid,
  Package,
  Radio,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { useTheme } from "@/lib/theme-context";
import { useSeller } from "@/lib/seller-context";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { mode, status, isBroadcasting } = useSeller();

  const isLiveRoute = location.startsWith("/live/") || isBroadcasting;
  const inSellerMode = mode === "seller" && status === "approved";

  return (
    <div className="flex justify-center w-full min-h-[100dvh] bg-stone-100 dark:bg-black/90">
      <div
        className={`w-full max-w-[390px] h-[100dvh] relative overflow-hidden font-sans select-none flex flex-col shadow-2xl ${
          isDark ? "bg-[#050505] text-white" : "bg-[#fbeed3] text-stone-900"
        }`}
      >
        <div
          className={`flex-1 overflow-y-auto no-scrollbar ${
            !isLiveRoute ? "pb-20" : ""
          }`}
        >
          {children}
        </div>

        {!isLiveRoute &&
          (inSellerMode ? (
            <SellerNav location={location} isDark={isDark} />
          ) : (
            <BuyerNav location={location} isDark={isDark} />
          ))}
      </div>
    </div>
  );
}

function navItemClasses(active: boolean, isDark: boolean) {
  return `flex flex-col items-center gap-1 w-16 ${
    active
      ? isDark
        ? "text-[#00ffff]"
        : "text-[#00b3b3]"
      : isDark
        ? "text-white/50 hover:text-white"
        : "text-stone-500 hover:text-stone-900"
  }`;
}

function NavBarShell({
  isDark,
  children,
}: {
  isDark: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`absolute bottom-0 left-0 right-0 h-20 backdrop-blur-xl border-t flex items-center justify-around px-2 pb-4 z-50 ${
        isDark
          ? "bg-[#0a0a0a]/90 border-white/5"
          : "bg-[#fff5d8]/92 border-stone-400/55"
      }`}
    >
      {children}
    </div>
  );
}

function CenterAction({
  isDark,
  href,
  testId,
}: {
  isDark: boolean;
  href: string;
  testId: string;
}) {
  return (
    <div className="relative -top-5">
      <Link
        href={href}
        data-testid={testId}
        className={`flex h-14 w-14 rounded-full p-[2px] ${
          isDark
            ? "bg-gradient-to-tr from-[#ff00ff] to-[#00ffff] shadow-[0_0_20px_rgba(255,0,255,0.4)]"
            : "bg-gradient-to-tr from-[#d900d9] to-[#00b3b3] shadow-md"
        }`}
      >
        <div
          className={`h-full w-full rounded-full flex items-center justify-center ${
            isDark ? "bg-black" : "bg-white"
          }`}
        >
          <Plus
            className={`h-6 w-6 ${
              isDark ? "text-white" : "text-stone-900"
            }`}
          />
        </div>
      </Link>
    </div>
  );
}

function BuyerNav({ location, isDark }: { location: string; isDark: boolean }) {
  return (
    <NavBarShell isDark={isDark}>
      <Link
        href="/"
        className={navItemClasses(location === "/", isDark)}
        data-testid="nav-home"
      >
        <Home className="h-6 w-6" />
        <span className="text-[10px] font-medium">Home</span>
      </Link>
      <Link
        href="/discover"
        className={navItemClasses(location === "/discover", isDark)}
        data-testid="nav-discover"
      >
        <Compass className="h-6 w-6" />
        <span className="text-[10px] font-medium">Discover</span>
      </Link>
      <CenterAction isDark={isDark} href="/seller/go-live" testId="nav-go-live-buyer" />
      <Link
        href="/inbox"
        className={`${navItemClasses(location === "/inbox", isDark)} relative`}
        data-testid="nav-inbox"
      >
        <MessageSquare className="h-6 w-6" />
        <span
          className={`absolute top-0 right-3 w-2 h-2 rounded-full ${
            isDark ? "bg-[#ff00ff]" : "bg-[#d900d9]"
          }`}
        ></span>
        <span className="text-[10px] font-medium">Inbox</span>
      </Link>
      <Link
        href="/profile"
        className={navItemClasses(location.startsWith("/profile") || location.startsWith("/account"), isDark)}
        data-testid="nav-profile"
      >
        <User className="h-6 w-6" />
        <span className="text-[10px] font-medium">Profile</span>
      </Link>
    </NavBarShell>
  );
}

function SellerNav({ location, isDark }: { location: string; isDark: boolean }) {
  return (
    <NavBarShell isDark={isDark}>
      <Link
        href="/seller/studio"
        className={navItemClasses(location === "/seller/studio", isDark)}
        data-testid="nav-studio"
      >
        <LayoutGrid className="h-6 w-6" />
        <span className="text-[10px] font-medium">Studio</span>
      </Link>
      <Link
        href="/seller/listings"
        className={navItemClasses(location === "/seller/listings", isDark)}
        data-testid="nav-listings"
      >
        <Package className="h-6 w-6" />
        <span className="text-[10px] font-medium">Listings</span>
      </Link>
      <CenterAction isDark={isDark} href="/seller/go-live" testId="nav-go-live-seller" />
      <Link
        href="/inbox"
        className={`${navItemClasses(location === "/inbox", isDark)} relative`}
        data-testid="nav-inbox-seller"
      >
        <MessageSquare className="h-6 w-6" />
        <span
          className={`absolute top-0 right-3 w-2 h-2 rounded-full ${
            isDark ? "bg-[#ff00ff]" : "bg-[#d900d9]"
          }`}
        ></span>
        <span className="text-[10px] font-medium">Inbox</span>
      </Link>
      <Link
        href="/profile"
        className={navItemClasses(location.startsWith("/profile") || location.startsWith("/account"), isDark)}
        data-testid="nav-profile-seller"
      >
        <Radio className="h-6 w-6" />
        <span className="text-[10px] font-medium">Profile</span>
      </Link>
    </NavBarShell>
  );
}
