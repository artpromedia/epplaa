import { createContext, useCallback, useContext, useMemo, ReactNode } from "react";
import { useLocalStorage } from "./use-local-storage";

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

function makeReviewId(): string {
  return `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function ReviewsProvider({ children }: { children: ReactNode }) {
  const [reviews, setReviews] = useLocalStorage<Review[]>("epplaa-reviews", []);

  const add = useCallback<ReviewsContextValue["add"]>(
    (input) => {
      const review: Review = {
        ...input,
        id: makeReviewId(),
        createdAtIso: new Date().toISOString(),
      };
      setReviews((prev) => {
        const filtered = prev.filter(
          (r) => !(r.orderId === input.orderId && r.productId === input.productId),
        );
        return [review, ...filtered];
      });
      return review;
    },
    [setReviews],
  );

  const remove = useCallback(
    (id: string) => setReviews((prev) => prev.filter((r) => r.id !== id)),
    [setReviews],
  );

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

  return (
    <ReviewsContext.Provider value={value}>{children}</ReviewsContext.Provider>
  );
}

export function useReviews(): ReviewsContextValue {
  const ctx = useContext(ReviewsContext);
  if (!ctx) throw new Error("useReviews must be used within a ReviewsProvider");
  return ctx;
}
