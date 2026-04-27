import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
} from "react";
import {
  useGetWallet,
  useWalletTopUp,
  useWalletSpend,
  useWalletWithdraw,
  useWalletRefund,
  useWalletPromoCredit,
  useUpdateWalletSettings,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export type WalletTxnKind =
  | "topup"
  | "refund"
  | "spend"
  | "withdrawal"
  | "promo";

export interface WalletTxn {
  id: string;
  kind: WalletTxnKind;
  amountMinor: number;
  label: string;
  refId?: string;
  atIso: string;
}

export interface PendingTopup {
  intentId: string;
  reference: string;
  gateway: string;
  amountMinor: number;
  authorizationUrl?: string | null;
  status: string;
}

interface WalletContextValue {
  balanceMinor: number;
  currencyCode: string;
  txns: WalletTxn[];
  topUp: (amountMinor: number, label?: string) => Promise<PendingTopup | null>;
  spend: (amountMinor: number, label: string, refId?: string) => boolean;
  creditPromo: (amountMinor: number, label: string, refId?: string) => void;
  refundFromReturn: (
    returnId: string,
    amountMinor: number,
    label: string,
  ) => void;
  withdraw: (amountMinor: number, destinationLabel: string) => boolean;
  resetWallet: () => void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const walletQuery = useGetWallet();
  const qc = useQueryClient();
  const invalidate = useCallback(
    () => qc.invalidateQueries({ queryKey: ["/api/wallet"] }),
    [qc],
  );

  const topUpMut = useWalletTopUp({ mutation: { onSuccess: invalidate } });
  const spendMut = useWalletSpend({ mutation: { onSuccess: invalidate } });
  const withdrawMut = useWalletWithdraw({ mutation: { onSuccess: invalidate } });
  const refundMut = useWalletRefund({ mutation: { onSuccess: invalidate } });
  const promoMut = useWalletPromoCredit({ mutation: { onSuccess: invalidate } });
  const settingsMut = useUpdateWalletSettings({ mutation: { onSuccess: invalidate } });

  const balanceMinor = walletQuery.data?.balanceMinor ?? 0;
  const currencyCode = walletQuery.data?.currencyCode ?? "NGN";
  const txns = useMemo<WalletTxn[]>(
    () =>
      (walletQuery.data?.txns ?? []).map((t) => ({
        id: t.id,
        kind: t.kind as WalletTxnKind,
        amountMinor: t.amountMinor,
        label: t.label,
        refId: t.refId ?? undefined,
        atIso: t.atIso,
      })),
    [walletQuery.data?.txns],
  );

  const topUp = useCallback<WalletContextValue["topUp"]>(
    async (amountMinor, label = "Top up") => {
      if (amountMinor <= 0) return null;
      const res = await topUpMut.mutateAsync({ data: { amountMinor, label } });
      const pt = (res as unknown as { pendingTopup?: PendingTopup }).pendingTopup;
      if (pt && pt.authorizationUrl) {
        window.location.href = pt.authorizationUrl;
      }
      return pt ?? null;
    },
    [topUpMut],
  );

  const creditPromo = useCallback<WalletContextValue["creditPromo"]>(
    (amountMinor, label, refId) => {
      if (amountMinor <= 0 || !label) return;
      promoMut.mutate({ data: { amountMinor, label, ...(refId ? { refId } : {}) } });
    },
    [promoMut],
  );

  const spend = useCallback<WalletContextValue["spend"]>(
    (amountMinor, label, refId) => {
      if (amountMinor <= 0) return false;
      if (balanceMinor < amountMinor) return false;
      spendMut.mutate({ data: { amountMinor, label, ...(refId ? { refId } : {}) } });
      return true;
    },
    [balanceMinor, spendMut],
  );

  const withdraw = useCallback<WalletContextValue["withdraw"]>(
    (amountMinor, destinationLabel) => {
      if (amountMinor <= 0) return false;
      if (balanceMinor < amountMinor) return false;
      withdrawMut.mutate({ data: { amountMinor, destinationLabel } });
      return true;
    },
    [balanceMinor, withdrawMut],
  );

  const refundFromReturn = useCallback<WalletContextValue["refundFromReturn"]>(
    (returnId, amountMinor, label) => {
      if (amountMinor <= 0) return;
      refundMut.mutate({ data: { returnId, amountMinor, label } });
    },
    [refundMut],
  );

  const resetWallet = useCallback(() => {
    settingsMut.mutate({ data: { currencyCode: "NGN" } });
  }, [settingsMut]);

  const value = useMemo<WalletContextValue>(
    () => ({
      balanceMinor,
      currencyCode,
      txns,
      topUp,
      spend,
      creditPromo,
      refundFromReturn,
      withdraw,
      resetWallet,
    }),
    [
      balanceMinor,
      currencyCode,
      txns,
      topUp,
      spend,
      creditPromo,
      refundFromReturn,
      withdraw,
      resetWallet,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}

export const TXN_LABEL: Record<WalletTxnKind, string> = {
  topup: "Top up",
  refund: "Refund",
  spend: "Spend",
  withdrawal: "Withdrawal",
  promo: "Promo credit",
};
