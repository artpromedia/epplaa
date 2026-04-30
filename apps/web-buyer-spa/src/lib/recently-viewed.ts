import { useCallback, useMemo } from "react";
import {
  useListRecentlyViewed,
  useTrackRecentlyViewed,
  useClearRecentlyViewed,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export function useRecentlyViewed() {
  const query = useListRecentlyViewed();
  const qc = useQueryClient();
  const invalidate = useCallback(
    () => qc.invalidateQueries({ queryKey: ["/api/recently-viewed"] }),
    [qc],
  );
  const trackMut = useTrackRecentlyViewed({ mutation: { onSuccess: invalidate } });
  const clearMut = useClearRecentlyViewed({ mutation: { onSuccess: invalidate } });

  const productIds = useMemo<string[]>(() => query.data ?? [], [query.data]);

  const track = useCallback(
    (productId: string) => trackMut.mutate({ productId }),
    [trackMut],
  );

  const clear = useCallback(() => clearMut.mutate(), [clearMut]);

  return { productIds, track, clear };
}
