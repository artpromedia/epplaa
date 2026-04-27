import { createContext, useCallback, useContext, useMemo, ReactNode } from "react";
import { useLocalStorage } from "./use-local-storage";

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
  const [followedSellers, setFollowedSellers] = useLocalStorage<string[]>(
    "epplaa-follows",
    [],
  );

  const isFollowing = useCallback(
    (sellerName: string) => followedSellers.includes(sellerName),
    [followedSellers],
  );

  const follow = useCallback(
    (sellerName: string) =>
      setFollowedSellers((prev) =>
        prev.includes(sellerName) ? prev : [...prev, sellerName],
      ),
    [setFollowedSellers],
  );

  const unfollow = useCallback(
    (sellerName: string) =>
      setFollowedSellers((prev) => prev.filter((s) => s !== sellerName)),
    [setFollowedSellers],
  );

  const toggle = useCallback(
    (sellerName: string) => {
      let nowFollowing = false;
      setFollowedSellers((prev) => {
        if (prev.includes(sellerName)) {
          nowFollowing = false;
          return prev.filter((s) => s !== sellerName);
        }
        nowFollowing = true;
        return [...prev, sellerName];
      });
      return nowFollowing;
    },
    [setFollowedSellers],
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

  return (
    <FollowsContext.Provider value={value}>{children}</FollowsContext.Provider>
  );
}

export function useFollows(): FollowsContextValue {
  const ctx = useContext(FollowsContext);
  if (!ctx) throw new Error("useFollows must be used within a FollowsProvider");
  return ctx;
}
