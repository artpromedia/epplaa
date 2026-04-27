import { createContext, useCallback, useContext, useMemo, ReactNode } from "react";
import { useLocalStorage } from "./use-local-storage";

interface WishlistContextValue {
  productIds: string[];
  isWishlisted: (productId: string) => boolean;
  add: (productId: string) => void;
  remove: (productId: string) => void;
  toggle: (productId: string) => boolean;
  clear: () => void;
  count: number;
}

const WishlistContext = createContext<WishlistContextValue | null>(null);

export function WishlistProvider({ children }: { children: ReactNode }) {
  const [productIds, setProductIds] = useLocalStorage<string[]>(
    "epplaa-wishlist",
    [],
  );

  const isWishlisted = useCallback(
    (productId: string) => productIds.includes(productId),
    [productIds],
  );

  const add = useCallback(
    (productId: string) =>
      setProductIds((prev) =>
        prev.includes(productId) ? prev : [productId, ...prev],
      ),
    [setProductIds],
  );

  const remove = useCallback(
    (productId: string) =>
      setProductIds((prev) => prev.filter((id) => id !== productId)),
    [setProductIds],
  );

  const toggle = useCallback(
    (productId: string) => {
      let nowSaved = false;
      setProductIds((prev) => {
        if (prev.includes(productId)) {
          nowSaved = false;
          return prev.filter((id) => id !== productId);
        }
        nowSaved = true;
        return [productId, ...prev];
      });
      return nowSaved;
    },
    [setProductIds],
  );

  const clear = useCallback(() => setProductIds([]), [setProductIds]);

  const value = useMemo<WishlistContextValue>(
    () => ({
      productIds,
      isWishlisted,
      add,
      remove,
      toggle,
      clear,
      count: productIds.length,
    }),
    [productIds, isWishlisted, add, remove, toggle, clear],
  );

  return (
    <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>
  );
}

export function useWishlist(): WishlistContextValue {
  const ctx = useContext(WishlistContext);
  if (!ctx) throw new Error("useWishlist must be used within a WishlistProvider");
  return ctx;
}
