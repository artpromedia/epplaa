import { createContext, useCallback, useContext, useMemo, ReactNode } from "react";
import {
  useListFollows,
  useFollowSeller,
  useUnfollowSeller,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

interface FollowsContextValue {
  followedSellers: string[];
  isFollowing: (sellerName: string) => boolean;
  follow: (sellerName: string) => void;
  unfollow: (sellerName: string) => void;
  toggle: (sellerName: string) => boolean;
  count: number;
}

const FollowsContext = createContext<FollowsContextValue | null>(null);

export function FollowsProvider({ children }: { children: ReactNode }) {
  const query = useListFollows();
  const qc = useQueryClient();
  const invalidate = useCallback(
    () => qc.invalidateQueries({ queryKey: ["/api/follows"] }),
    [qc],
  );
  const followMut = useFollowSeller({ mutation: { onSuccess: invalidate } });
  const unfollowMut = useUnfollowSeller({ mutation: { onSuccess: invalidate } });

  const followedSellers = useMemo<string[]>(() => query.data ?? [], [query.data]);

  const isFollowing = useCallback(
    (sellerName: string) => followedSellers.includes(sellerName),
    [followedSellers],
  );

  const follow = useCallback(
    (sellerName: string) => {
      if (!followedSellers.includes(sellerName)) followMut.mutate({ sellerName });
    },
    [followedSellers, followMut],
  );

  const unfollow = useCallback(
    (sellerName: string) => unfollowMut.mutate({ sellerName }),
    [unfollowMut],
  );

  const toggle = useCallback(
    (sellerName: string) => {
      if (followedSellers.includes(sellerName)) {
        unfollowMut.mutate({ sellerName });
        return false;
      }
      followMut.mutate({ sellerName });
      return true;
    },
    [followedSellers, followMut, unfollowMut],
  );

  const value = useMemo<FollowsContextValue>(
    () => ({
      followedSellers,
      isFollowing,
      follow,
      unfollow,
      toggle,
      count: followedSellers.length,
    }),
    [followedSellers, isFollowing, follow, unfollow, toggle],
  );

  return <FollowsContext.Provider value={value}>{children}</FollowsContext.Provider>;
}

export function useFollows(): FollowsContextValue {
  const ctx = useContext(FollowsContext);
  if (!ctx) throw new Error("useFollows must be used within a FollowsProvider");
  return ctx;
}
