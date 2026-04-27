import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  useGetSellerMe,
  useApplySeller,
  useSetSellerMode,
  useUpgradeSellerTier,
  useListSellerListings,
  useCreateSellerListing,
  useDeleteSellerListing,
  useUpdateSellerListing,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { CountryCode } from "./countries";
import { SellerTier, tierFromSocialFollowers } from "./seller-tiers";

export type SellerStatus = "none" | "pending" | "approved" | "rejected";
export type AppMode = "buyer" | "seller";
export type BusinessType = "individual" | "registered" | "brand";

export type SocialPlatform = "instagram" | "tiktok" | "twitter" | "facebook" | "youtube";

export interface SocialAccount {
  platform: SocialPlatform;
  handle: string;
  followers: number;
}

export interface SellerApplication {
  businessType: BusinessType;
  legalName: string;
  storeName: string;
  storeHandle: string;
  storeBio: string;
  primaryCategory: string;
  countryCode: CountryCode;
  identification: { typeCode: string; typeLabel: string; last4: string };
  govIdLabel: string;
  payoutBank: string;
  payoutAccountLast4: string;
  registryNumber?: string;
  registryShortName?: string;
  trademarkRef?: string;
  socialAccounts: SocialAccount[];
  totalFollowers: number;
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
  submitApplication: (app: Omit<SellerApplication, "submittedAt">) => void;
  upgradeTier: (target: SellerTier, extra: { registryNumber?: string; trademarkRef?: string }) => void;
  addListing: (l: Omit<Listing, "id" | "createdAt" | "status">) => Promise<Listing>;
  updateListing: (id: string, patch: Partial<Listing>) => void;
  removeListing: (id: string) => void;
  recordBroadcast: (data: BroadcastDraft) => void;
  simulateSale: (amountMinor: number) => void;
  resetSeller: () => void;
  isBroadcasting: boolean;
  setIsBroadcasting: (v: boolean) => void;
}

const SellerContext = createContext<SellerContextValue | undefined>(undefined);

export function SellerProvider({ children }: { children: React.ReactNode }) {
  const profileQuery = useGetSellerMe();
  const listingsQuery = useListSellerListings();
  const qc = useQueryClient();

  const invalidateProfile = useCallback(
    () => qc.invalidateQueries({ queryKey: ["/api/seller/me"] }),
    [qc],
  );
  const invalidateListings = useCallback(
    () => qc.invalidateQueries({ queryKey: ["/api/seller/listings"] }),
    [qc],
  );

  const applyMut = useApplySeller({ mutation: { onSuccess: invalidateProfile } });
  const setModeMut = useSetSellerMode({ mutation: { onSuccess: invalidateProfile } });
  const upgradeMut = useUpgradeSellerTier({ mutation: { onSuccess: invalidateProfile } });
  const createListingMut = useCreateSellerListing({ mutation: { onSuccess: invalidateListings } });
  const deleteListingMut = useDeleteSellerListing({ mutation: { onSuccess: invalidateListings } });
  const updateListingMut = useUpdateSellerListing({ mutation: { onSuccess: invalidateListings } });

  const [isBroadcasting, setIsBroadcasting] = useState(false);

  const profile = profileQuery.data;
  const status: SellerStatus = (profile?.status as SellerStatus) ?? "none";
  const tier: SellerTier = (profile?.tier as SellerTier) ?? "starter";
  const apiMode: AppMode = (profile?.mode as AppMode) ?? "buyer";
  const application = (profile?.application as SellerApplication | null | undefined) ?? null;
  const stats = (profile?.stats as SellerStats | null | undefined) ?? null;

  const listings = useMemo<Listing[]>(
    () =>
      (listingsQuery.data ?? []).map((l) => ({
        id: l.id,
        title: l.title,
        priceMinor: l.priceMinor,
        countryCode: l.countryCode as CountryCode,
        category: l.category,
        inventory: l.inventory,
        status: l.status as "draft" | "active",
        createdAt: new Date(l.createdAtIso).getTime(),
      })),
    [listingsQuery.data],
  );

  function setMode(next: AppMode) {
    if (next === "seller" && status !== "approved") return;
    setModeMut.mutate({ data: { mode: next } });
  }

  function submitApplication(app: Omit<SellerApplication, "submittedAt">) {
    applyMut.mutate({
      data: {
        ...app,
        submittedAt: Date.now(),
        startingTier: tierFromSocialFollowers(app.totalFollowers),
      } as Record<string, unknown>,
    });
  }

  function upgradeTier(target: SellerTier, extra: { registryNumber?: string; trademarkRef?: string }) {
    upgradeMut.mutate({ data: { tier: target, ...extra } });
  }

  async function addListing(l: Omit<Listing, "id" | "createdAt" | "status">): Promise<Listing> {
    const created = await createListingMut.mutateAsync({
      data: {
        title: l.title,
        priceMinor: l.priceMinor,
        countryCode: l.countryCode,
        category: l.category,
        inventory: l.inventory,
      },
    });
    return {
      id: created.id,
      title: created.title,
      priceMinor: created.priceMinor,
      countryCode: created.countryCode as CountryCode,
      category: created.category,
      inventory: created.inventory,
      status: created.status as "draft" | "active",
      createdAt: new Date(created.createdAtIso).getTime(),
    };
  }

  function updateListing(id: string, patch: Partial<Listing>) {
    const data: Record<string, unknown> = {};
    if (typeof patch.title === "string") data.title = patch.title;
    if (typeof patch.priceMinor === "number") data.priceMinor = patch.priceMinor;
    if (typeof patch.category === "string") data.category = patch.category;
    if (typeof patch.inventory === "number") data.inventory = patch.inventory;
    if (patch.status === "draft" || patch.status === "active") data.status = patch.status;
    if (Object.keys(data).length === 0) return;
    updateListingMut.mutate({ listingId: id, data });
  }

  function removeListing(id: string) {
    deleteListingMut.mutate({ listingId: id });
  }

  function recordBroadcast(_data: BroadcastDraft) {}

  function simulateSale(_amountMinor: number) {}

  function resetSeller() {
    setModeMut.mutate({ data: { mode: "buyer" } });
  }

  const value = useMemo<SellerContextValue>(
    () => ({
      status,
      tier,
      mode: status === "approved" ? apiMode : "buyer",
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, tier, apiMode, application, stats, listings, isBroadcasting],
  );

  return <SellerContext.Provider value={value}>{children}</SellerContext.Provider>;
}

export function useSeller() {
  const ctx = useContext(SellerContext);
  if (!ctx) throw new Error("useSeller must be used within a SellerProvider");
  return ctx;
}
