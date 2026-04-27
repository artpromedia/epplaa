import { createContext, useContext, useMemo, ReactNode } from "react";
import { useLocalStorage } from "./use-local-storage";
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
  const [items, setItems] = useLocalStorage<CartItem[]>("epplaa-cart", []);

  const value = useMemo<CartContextValue>(() => {
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
    const subtotalMinor = resolved.reduce(
      (acc, it) => acc + it.lineTotalMinor,
      0,
    );

    return {
      items,
      resolved,
      count,
      subtotalMinor,
      add: (productId, qty = 1, variantNotes) => {
        setItems((prev) => {
          const idx = prev.findIndex((p) => p.productId === productId);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], qty: next[idx].qty + qty };
            return next;
          }
          return [...prev, { productId, qty, variantNotes }];
        });
      },
      remove: (productId) => {
        setItems((prev) => prev.filter((p) => p.productId !== productId));
      },
      setQty: (productId, qty) => {
        setItems((prev) => {
          if (qty <= 0) return prev.filter((p) => p.productId !== productId);
          return prev.map((p) =>
            p.productId === productId ? { ...p, qty } : p,
          );
        });
      },
      clear: () => setItems([]),
    };
  }, [items, setItems]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside CartProvider");
  return ctx;
}
