import { createContext, useCallback, useContext, useMemo, ReactNode } from "react";
import { useListReviews, useCreateReview } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export interface Review {
  id: string;
  orderId: string;
  productId: string;
  sellerName: string;
  rating: number;
  text: string;
  createdAtIso: string;
}

interface ReviewsContextValue {
  reviews: Review[];
  add: (input: Omit<Review, "id" | "createdAtIso">) => Review;
  remove: (id: string) => void;
  getForOrderItem: (orderId: string, productId: string) => Review | undefined;
  getForProduct: (productId: string) => Review[];
  getForSeller: (sellerName: string) => Review[];
  averageForProduct: (productId: string, fallback?: number) => number;
  averageForSeller: (sellerName: string, fallback?: number) => number;
}

const ReviewsContext = createContext<ReviewsContextValue | null>(null);

export function ReviewsProvider({ children }: { children: ReactNode }) {
  const query = useListReviews();
  const qc = useQueryClient();
  const createMut = useCreateReview({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/reviews"] }),
    },
  });

  const reviews = useMemo<Review[]>(
    () =>
      (query.data ?? []).map((r) => ({
        id: r.id,
        orderId: r.orderId,
        productId: r.productId,
        sellerName: r.sellerName,
        rating: r.rating,
        text: r.text,
        createdAtIso: r.createdAtIso,
      })),
    [query.data],
  );

  const add = useCallback<ReviewsContextValue["add"]>(
    (input) => {
      const optimistic: Review = {
        ...input,
        id: `tmp_${Date.now()}`,
        createdAtIso: new Date().toISOString(),
      };
      createMut.mutate({
        data: {
          orderId: input.orderId,
          productId: input.productId,
          sellerName: input.sellerName,
          rating: input.rating,
          text: input.text,
        },
      });
      return optimistic;
    },
    [createMut],
  );

  // The API does not yet expose a delete endpoint; treat as a no-op so callers
  // never crash. Future: wire to DELETE /reviews/{reviewId}.
  const remove = useCallback((_id: string) => {}, []);

  const getForOrderItem = useCallback(
    (orderId: string, productId: string) =>
      reviews.find((r) => r.orderId === orderId && r.productId === productId),
    [reviews],
  );
  const getForProduct = useCallback(
    (productId: string) => reviews.filter((r) => r.productId === productId),
    [reviews],
  );
  const getForSeller = useCallback(
    (sellerName: string) => reviews.filter((r) => r.sellerName === sellerName),
    [reviews],
  );
  const averageForProduct = useCallback(
    (productId: string, fallback = 0) => {
      const list = reviews.filter((r) => r.productId === productId);
      if (list.length === 0) return fallback;
      return list.reduce((s, r) => s + r.rating, 0) / list.length;
    },
    [reviews],
  );
  const averageForSeller = useCallback(
    (sellerName: string, fallback = 0) => {
      const list = reviews.filter((r) => r.sellerName === sellerName);
      if (list.length === 0) return fallback;
      return list.reduce((s, r) => s + r.rating, 0) / list.length;
    },
    [reviews],
  );

  const value = useMemo<ReviewsContextValue>(
    () => ({
      reviews,
      add,
      remove,
      getForOrderItem,
      getForProduct,
      getForSeller,
      averageForProduct,
      averageForSeller,
    }),
    [reviews, add, remove, getForOrderItem, getForProduct, getForSeller, averageForProduct, averageForSeller],
  );

  return <ReviewsContext.Provider value={value}>{children}</ReviewsContext.Provider>;
}

export function useReviews(): ReviewsContextValue {
  const ctx = useContext(ReviewsContext);
  if (!ctx) throw new Error("useReviews must be used within a ReviewsProvider");
  return ctx;
}
