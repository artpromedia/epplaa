import { createContext, useContext, useMemo, ReactNode, useCallback } from "react";
import {
  useGetCart,
  useUpsertCartItem,
  useRemoveCartItem,
  useClearCart,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { SEED_PRODUCTS } from "./seed";

export interface CartItem {
  productId: string;
  qty: number;
  variantNotes?: string;
}

export interface ResolvedCartItem extends CartItem {
  title: string;
  priceMinor: number;
  image: string;
  sellerName: string;
  lineTotalMinor: number;
}

interface CartContextValue {
  items: CartItem[];
  resolved: ResolvedCartItem[];
  count: number;
  subtotalMinor: number;
  add: (productId: string, qty?: number, variantNotes?: string) => void;
  remove: (productId: string) => void;
  setQty: (productId: string, qty: number) => void;
  clear: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const cartQuery = useGetCart();
  const qc = useQueryClient();

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["/api/cart"] });
  }, [qc]);

  const upsert = useUpsertCartItem({ mutation: { onSuccess: invalidate } });
  const removeMut = useRemoveCartItem({ mutation: { onSuccess: invalidate } });
  const clearMut = useClearCart({ mutation: { onSuccess: invalidate } });

  const value = useMemo<CartContextValue>(() => {
    const items: CartItem[] = (cartQuery.data?.items ?? []).map((it) => ({
      productId: it.productId,
      qty: it.qty,
      variantNotes: it.variantNotes ?? undefined,
    }));

    const resolved: ResolvedCartItem[] = items.flatMap((it) => {
      const p = SEED_PRODUCTS.find((sp) => sp.id === it.productId);
      if (!p) return [];
      return [
        {
          ...it,
          title: p.title,
          priceMinor: p.priceMinor,
          image: p.images[0],
          sellerName: p.sellerName,
          lineTotalMinor: p.priceMinor * it.qty,
        },
      ];
    });

    const count = items.reduce((acc, it) => acc + it.qty, 0);
    const subtotalMinor = resolved.reduce((acc, it) => acc + it.lineTotalMinor, 0);

    function add(productId: string, qty: number = 1, variantNotes?: string) {
      const existing = items.find((p) => p.productId === productId);
      const nextQty = (existing?.qty ?? 0) + qty;
      upsert.mutate({
        productId,
        data: { qty: nextQty, ...(variantNotes ? { variantNotes } : {}) },
      });
    }
    function remove(productId: string) {
      removeMut.mutate({ productId });
    }
    function setQty(productId: string, qty: number) {
      if (qty <= 0) {
        removeMut.mutate({ productId });
        return;
      }
      upsert.mutate({ productId, data: { qty } });
    }
    function clear() {
      clearMut.mutate();
    }

    return { items, resolved, count, subtotalMinor, add, remove, setQty, clear };
  }, [cartQuery.data, upsert, removeMut, clearMut]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside CartProvider");
  return ctx;
}
