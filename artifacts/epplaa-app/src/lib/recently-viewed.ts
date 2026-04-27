import { useCallback } from "react";
import { useLocalStorage } from "./use-local-storage";

const KEY = "epplaa-recently-viewed";
const MAX = 12;

export function useRecentlyViewed() {
  const [productIds, setProductIds] = useLocalStorage<string[]>(KEY, []);

  const track = useCallback(
    (productId: string) => {
      setProductIds((prev) => {
        const filtered = prev.filter((id) => id !== productId);
        return [productId, ...filtered].slice(0, MAX);
      });
    },
    [setProductIds],
  );

  const clear = useCallback(() => setProductIds([]), [setProductIds]);

  return { productIds, track, clear };
}
