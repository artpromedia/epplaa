import { createContext, useCallback, useContext, useMemo, ReactNode } from "react";
import {
  useListWishlist,
  useAddToWishlist,
  useRemoveFromWishlist,
  useClearWishlist,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

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
  const query = useListWishlist();
  const qc = useQueryClient();
  const invalidate = useCallback(
    () => qc.invalidateQueries({ queryKey: ["/api/wishlist"] }),
    [qc],
  );
  const addMut = useAddToWishlist({ mutation: { onSuccess: invalidate } });
  const removeMut = useRemoveFromWishlist({ mutation: { onSuccess: invalidate } });
  const clearMut = useClearWishlist({ mutation: { onSuccess: invalidate } });

  const productIds = useMemo<string[]>(() => query.data ?? [], [query.data]);

  const isWishlisted = useCallback(
    (productId: string) => productIds.includes(productId),
    [productIds],
  );

  const add = useCallback(
    (productId: string) => {
      if (!productIds.includes(productId)) addMut.mutate({ productId });
    },
    [productIds, addMut],
  );

  const remove = useCallback(
    (productId: string) => removeMut.mutate({ productId }),
    [removeMut],
  );

  const toggle = useCallback(
    (productId: string) => {
      if (productIds.includes(productId)) {
        removeMut.mutate({ productId });
        return false;
      }
      addMut.mutate({ productId });
      return true;
    },
    [productIds, addMut, removeMut],
  );

  const clear = useCallback(() => clearMut.mutate(), [clearMut]);

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

  return <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>;
}

export function useWishlist(): WishlistContextValue {
  const ctx = useContext(WishlistContext);
  if (!ctx) throw new Error("useWishlist must be used within a WishlistProvider");
  return ctx;
}
