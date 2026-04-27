import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
} from "react";
import { useLocalStorage } from "./use-local-storage";

export type WalletTxnKind =
  | "topup"
  | "refund"
  | "spend"
  | "withdrawal"
  | "promo";

export interface WalletTxn {
  id: string;
  kind: WalletTxnKind;
  amountMinor: number; // positive credits, negative debits
  label: string;
  refId?: string;
  atIso: string;
}

const SEED_TXNS: WalletTxn[] = [
  {
    id: "wt-seed-1",
    kind: "promo",
    amountMinor: 200000, // 2,000 NGN
    label: "Welcome credit",
    atIso: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "wt-seed-2",
    kind: "spend",
    amountMinor: -125000,
    label: "Order EP-K9X8 (partial)",
    atIso: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
  },
];

interface WalletContextValue {
  balanceMinor: number;
  currencyCode: string;
  txns: WalletTxn[];
  topUp: (amountMinor: number, label?: string) => void;
  spend: (amountMinor: number, label: string, refId?: string) => boolean;
  refundFromReturn: (
    returnId: string,
    amountMinor: number,
    label: string,
  ) => void;
  withdraw: (amountMinor: number, destinationLabel: string) => boolean;
  resetWallet: () => void;
}

const WalletContext = createContext<WalletContextValue | null>(null);
const STORAGE_KEY = "epplaa-wallet-txns";
const CCY_KEY = "epplaa-wallet-ccy";

function makeId() {
  return `wt_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [txns, setTxns] = useLocalStorage<WalletTxn[]>(STORAGE_KEY, SEED_TXNS);
  const [currencyCode, setCurrencyCode] = useLocalStorage<string>(CCY_KEY, "NGN");

  const balanceMinor = useMemo(
    () => txns.reduce((acc, t) => acc + t.amountMinor, 0),
    [txns],
  );

  const topUp = useCallback<WalletContextValue["topUp"]>(
    (amountMinor, label = "Top up") => {
      if (amountMinor <= 0) return;
      setTxns((prev) => [
        {
          id: makeId(),
          kind: "topup",
          amountMinor,
          label,
          atIso: new Date().toISOString(),
        },
        ...prev,
      ]);
    },
    [setTxns],
  );

  const spend = useCallback<WalletContextValue["spend"]>(
    (amountMinor, label, refId) => {
      if (amountMinor <= 0) return false;
      if (balanceMinor < amountMinor) return false;
      setTxns((prev) => [
        {
          id: makeId(),
          kind: "spend",
          amountMinor: -amountMinor,
          label,
          refId,
          atIso: new Date().toISOString(),
        },
        ...prev,
      ]);
      return true;
    },
    [balanceMinor, setTxns],
  );

  const refundFromReturn = useCallback<WalletContextValue["refundFromReturn"]>(
    (returnId, amountMinor, label) => {
      setTxns((prev) => {
        if (prev.some((t) => t.refId === returnId && t.kind === "refund")) {
          return prev;
        }
        return [
          {
            id: makeId(),
            kind: "refund",
            amountMinor,
            label,
            refId: returnId,
            atIso: new Date().toISOString(),
          },
          ...prev,
        ];
      });
    },
    [setTxns],
  );

  const withdraw = useCallback<WalletContextValue["withdraw"]>(
    (amountMinor, destinationLabel) => {
      if (amountMinor <= 0) return false;
      if (balanceMinor < amountMinor) return false;
      setTxns((prev) => [
        {
          id: makeId(),
          kind: "withdrawal",
          amountMinor: -amountMinor,
          label: `Withdraw to ${destinationLabel}`,
          atIso: new Date().toISOString(),
        },
        ...prev,
      ]);
      return true;
    },
    [balanceMinor, setTxns],
  );

  const resetWallet = useCallback(() => {
    setTxns(SEED_TXNS);
    setCurrencyCode("NGN");
  }, [setTxns, setCurrencyCode]);

  const value = useMemo<WalletContextValue>(
    () => ({
      balanceMinor,
      currencyCode,
      txns,
      topUp,
      spend,
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
      refundFromReturn,
      withdraw,
      resetWallet,
    ],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
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
