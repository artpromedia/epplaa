import React, { createContext, useContext, useMemo, useState } from "react";
import { useLocalStorage } from "./use-local-storage";
import { CountryCode } from "./countries";
import { SellerTier, TIERS } from "./seller-tiers";

export type SellerStatus = "none" | "pending" | "approved" | "rejected";
export type AppMode = "buyer" | "seller";
export type BusinessType = "individual" | "registered" | "brand";

export interface SellerApplication {
  businessType: BusinessType;
  legalName: string;
  storeName: string;
  storeHandle: string;
  storeBio: string;
  primaryCategory: string;
  countryCode: CountryCode;
  identification: { type: "BVN" | "NIN"; last4: string };
  govIdLabel: string;
  payoutBank: string;
  payoutAccountLast4: string;
  cacNumber?: string;
  trademarkRef?: string;
  submittedAt: number;
}

export interface SellerStats {
  lifetimeGMVMinor: number;
  thisMonthGMVMinor: number;
  ordersTotal: number;
  ordersPending: number;
  liveSessionsCount: number;
  joinedAt: number;
}

export interface Listing {
  id: string;
  title: string;
  priceMinor: number;
  countryCode: CountryCode;
  category: string;
  inventory: number;
  status: "draft" | "active";
  createdAt: number;
}

export interface BroadcastDraft {
  title: string;
  category: string;
  listingIds: string[];
}

interface SellerContextValue {
  status: SellerStatus;
  tier: SellerTier;
  mode: AppMode;
  application: SellerApplication | null;
  stats: SellerStats | null;
  listings: Listing[];
  setMode: (mode: AppMode) => void;
  submitApplication: (
    app: Omit<SellerApplication, "submittedAt">,
  ) => void;
  upgradeTier: (
    target: SellerTier,
    extra: { cacNumber?: string; trademarkRef?: string },
  ) => void;
  addListing: (
    l: Omit<Listing, "id" | "createdAt" | "status">,
  ) => Listing;
  updateListing: (id: string, patch: Partial<Listing>) => void;
  removeListing: (id: string) => void;
  recordBroadcast: (data: BroadcastDraft) => void;
  simulateSale: (amountMinor: number) => void;
  resetSeller: () => void;
  isBroadcasting: boolean;
  setIsBroadcasting: (v: boolean) => void;
}

const SellerContext = createContext<SellerContextValue | undefined>(undefined);

const STATUS_KEY = "epplaa-seller-status";
const TIER_KEY = "epplaa-seller-tier";
const MODE_KEY = "epplaa-app-mode";
const APP_KEY = "epplaa-seller-application";
const STATS_KEY = "epplaa-seller-stats";
const LISTINGS_KEY = "epplaa-seller-listings";

export function SellerProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useLocalStorage<SellerStatus>(STATUS_KEY, "none");
  const [tier, setTier] = useLocalStorage<SellerTier>(TIER_KEY, "starter");
  const [mode, setModeState] = useLocalStorage<AppMode>(MODE_KEY, "buyer");
  const [application, setApplication] =
    useLocalStorage<SellerApplication | null>(APP_KEY, null);
  const [stats, setStats] = useLocalStorage<SellerStats | null>(STATS_KEY, null);
  const [listings, setListings] = useLocalStorage<Listing[]>(LISTINGS_KEY, []);
  const [isBroadcasting, setIsBroadcasting] = useState(false);

  function setMode(next: AppMode) {
    if (next === "seller" && status !== "approved") return;
    setModeState(next);
  }

  function submitApplication(app: Omit<SellerApplication, "submittedAt">) {
    const now = Date.now();
    setApplication({ ...app, submittedAt: now });
    // Demo: auto-approve to Starter immediately. Production would set "pending".
    setStatus("approved");
    setTier("starter");
    setStats({
      lifetimeGMVMinor: 0,
      thisMonthGMVMinor: 0,
      ordersTotal: 0,
      ordersPending: 0,
      liveSessionsCount: 0,
      joinedAt: now,
    });
  }

  function upgradeTier(
    target: SellerTier,
    extra: { cacNumber?: string; trademarkRef?: string },
  ) {
    setTier(target);
    if (application) {
      setApplication({
        ...application,
        cacNumber: extra.cacNumber ?? application.cacNumber,
        trademarkRef: extra.trademarkRef ?? application.trademarkRef,
        businessType:
          target === "pro"
            ? "registered"
            : target === "elite"
              ? "brand"
              : application.businessType,
      });
    }
  }

  function addListing(l: Omit<Listing, "id" | "createdAt" | "status">) {
    const cap = TIERS[tier].maxListings;
    const activeCount = listings.filter((x) => x.status === "active").length;
    const next: Listing = {
      ...l,
      id: `lst_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
      status: cap !== null && activeCount >= cap ? "draft" : "active",
    };
    setListings((prev) => [next, ...prev]);
    return next;
  }

  function updateListing(id: string, patch: Partial<Listing>) {
    setListings((prev) =>
      prev.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    );
  }

  function removeListing(id: string) {
    setListings((prev) => prev.filter((l) => l.id !== id));
  }

  function recordBroadcast(_data: BroadcastDraft) {
    setStats((prev) =>
      prev
        ? { ...prev, liveSessionsCount: prev.liveSessionsCount + 1 }
        : prev,
    );
  }

  function simulateSale(amountMinor: number) {
    setStats((prev) =>
      prev
        ? {
            ...prev,
            lifetimeGMVMinor: prev.lifetimeGMVMinor + amountMinor,
            thisMonthGMVMinor: prev.thisMonthGMVMinor + amountMinor,
            ordersTotal: prev.ordersTotal + 1,
            ordersPending: prev.ordersPending + 1,
          }
        : prev,
    );
  }

  function resetSeller() {
    setStatus("none");
    setTier("starter");
    setModeState("buyer");
    setApplication(null);
    setStats(null);
    setListings([]);
  }

  const value = useMemo<SellerContextValue>(
    () => ({
      status,
      tier,
      mode: status === "approved" ? mode : "buyer",
      application,
      stats,
      listings,
      setMode,
      submitApplication,
      upgradeTier,
      addListing,
      updateListing,
      removeListing,
      recordBroadcast,
      simulateSale,
      resetSeller,
      isBroadcasting,
      setIsBroadcasting,
    }),
    [status, tier, mode, application, stats, listings, isBroadcasting],
  );

  return (
    <SellerContext.Provider value={value}>{children}</SellerContext.Provider>
  );
}

export function useSeller() {
  const ctx = useContext(SellerContext);
  if (!ctx) throw new Error("useSeller must be used within a SellerProvider");
  return ctx;
}
