import { useCallback, useMemo } from "react";
import { useGetMe, useUpdateMe } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type Patch = "addresses" | "paymentMethods";

export function useMeArray<T>(field: Patch): [T[], (next: T[] | ((prev: T[]) => T[])) => void] {
  const meQuery = useGetMe();
  const qc = useQueryClient();
  const updateMut = useUpdateMe({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/me"] }) },
  });

  const list = useMemo<T[]>(
    () => ((meQuery.data?.[field] ?? []) as unknown as T[]) ?? [],
    [meQuery.data, field],
  );

  const setList = useCallback(
    (next: T[] | ((prev: T[]) => T[])) => {
      const value = typeof next === "function" ? (next as (p: T[]) => T[])(list) : next;
      const optimistic = { ...(meQuery.data ?? {}), [field]: value };
      qc.setQueryData(["/api/me"], optimistic);
      updateMut.mutate({ data: { [field]: value as unknown as Record<string, unknown>[] } });
    },
    [list, meQuery.data, updateMut, qc, field],
  );

  return [list, setList];
}
