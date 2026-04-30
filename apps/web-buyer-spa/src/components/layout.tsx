import {
  Home,
  Compass,
  Plus,
  MessageSquare,
  User,
  LayoutGrid,
  Package,
  Radio,
  ShoppingBag,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { useTheme } from "@/lib/theme-context";
import { useSeller } from "@/lib/seller-context";
import { useCart } from "@/lib/cart-context";
import { SystemStatusBanner } from "@/components/system-status-banner";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { mode, status, isBroadcasting } = useSeller();
  const { count } = useCart();

  const isLiveRoute = location.startsWith("/live/") || isBroadcasting;
  // Replay detail is a full-screen viewer (same UX as live); the listing page
  // /replays keeps the bottom nav so users can browse other tabs.
  const isReplayDetail = location.startsWith("/replay/");
  const inSellerMode = mode === "seller" && status === "approved";

  // Cart + checkout flows are full-screen with their own sticky action bar; the
  // tab nav would overlap that bar, so hide it on those routes (escape via the
  // page-header back arrow).
  const isCheckoutFlow =
    location === "/cart" || location.startsWith("/checkout");
  const isRateFlow = /^\/orders\/[^/]+\/rate$/.test(location);
  const isReturnRequestFlow = location.startsWith("/returns/new/");
  const isSafetyReportFlow = location.startsWith("/safety/report");
  const hideTabNav =
    isLiveRoute ||
    isReplayDetail ||
    isCheckoutFlow ||
    isRateFlow ||
    isReturnRequestFlow ||
    isSafetyReportFlow;

  // Hide floating cart on routes where it would be redundant or get in the way.
  const hideFloatingCart =
    inSellerMode ||
    isCheckoutFlow ||
    isRateFlow ||
    isReturnRequestFlow ||
    isSafetyReportFlow ||
    location.startsWith("/product/") || // product detail has its own CTA
    location.startsWith("/wallet") ||
    location.startsWith("/safety") ||
    location.startsWith("/referrals") ||
    isLiveRoute ||
    isReplayDetail;

  return (
    <div className="flex justify-center w-full min-h-[100dvh] bg-stone-100 dark:bg-black/90">
      <div
        className={`w-full max-w-[390px] h-[100dvh] relative overflow-hidden font-sans select-none flex flex-col shadow-2xl ${
          isDark ? "bg-[#0F1525] text-white" : "bg-[#fbeed3] text-stone-900"
        }`}
      >
        <div
          className={`flex-1 overflow-y-auto no-scrollbar ${
            !hideTabNav ? "pb-20" : ""
          }`}
        >
          <SystemStatusBanner />
          {children}
        </div>

        {!hideFloatingCart && count > 0 && (
          <FloatingCart isDark={isDark} count={count} />
        )}

        {!hideTabNav &&
          (inSellerMode ? (
            <SellerNav location={location} isDark={isDark} />
          ) : (
            <BuyerNav location={location} isDark={isDark} />
          ))}
      </div>
    </div>
  );
}

function FloatingCart({ isDark, count }: { isDark: boolean; count: number }) {
  return (
    <Link
      href="/cart"
      data-testid="link-floating-cart"
      aria-label={`Cart (${count} item${count === 1 ? "" : "s"})`}
      className={`absolute top-12 right-4 z-40 h-11 w-11 rounded-full flex items-center justify-center shadow-lg backdrop-blur-md ${
        isDark
          ? "bg-[#171C30]/90 text-white border border-white/10"
          : "bg-[#fff5d8]/95 text-stone-900 border border-stone-400/55"
      }`}
    >
      <ShoppingBag className="h-5 w-5" />
      <span
        className={`absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-black flex items-center justify-center text-white ${
          isDark ? "bg-[#FF8855]" : "bg-[#E6502E]"
        }`}
        data-testid="text-cart-count"
      >
        {count > 99 ? "99+" : count}
      </span>
    </Link>
  );
}

function navItemClasses(active: boolean, isDark: boolean) {
  return `flex flex-col items-center gap-1 w-16 ${
    active
      ? isDark
        ? "text-[#5BA3F5]"
        : "text-[#1B2A4A]"
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
          ? "bg-[#171C30]/90 border-white/5"
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
            ? "bg-gradient-to-tr from-[#FF8855] to-[#5BA3F5] shadow-[0_0_20px_rgba(255,136,85,0.4)]"
            : "bg-gradient-to-tr from-[#E6502E] to-[#1B2A4A] shadow-md"
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
            isDark ? "bg-[#FF8855]" : "bg-[#E6502E]"
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
            isDark ? "bg-[#FF8855]" : "bg-[#E6502E]"
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
