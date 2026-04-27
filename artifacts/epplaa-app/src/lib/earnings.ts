import { useCallback, useMemo } from "react";
import { useLocalStorage } from "./use-local-storage";
import { useSeller } from "./seller-context";
import { Country } from "./countries";

const COMMISSION_RATE = 0.1;
const HOLD_DAYS = 3;

export interface PayoutRequest {
  id: string;
  requestedAtIso: string;
  amountMinor: number;
  status: "pending" | "paid" | "rejected";
  bankLabel: string;
  bankLast4: string;
  reference: string;
  paidAtIso?: string;
}

export interface EarningsSummary {
  lifetimeGmvMinor: number;
  thisMonthGmvMinor: number;
  commissionMinor: number;
  netLifetimeMinor: number;
  pendingPayoutMinor: number;
  paidOutMinor: number;
  availableMinor: number;
  ordersTotal: number;
  ordersPending: number;
  payouts: PayoutRequest[];
  payoutThresholdMinor: number;
  holdDays: number;
}

function makePayoutId(): string {
  return `po_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function makePayoutReference(): string {
  return `PO-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

export function useSellerEarnings(country: Country): {
  summary: EarningsSummary;
  requestPayout: (amountMinor: number) => PayoutRequest | null;
  markPayoutPaid: (id: string) => void;
} {
  const { stats, application } = useSeller();
  const [payouts, setPayouts] = useLocalStorage<PayoutRequest[]>(
    "epplaa-payouts",
    [],
  );

  const summary = useMemo<EarningsSummary>(() => {
    const lifetimeGmvMinor = stats?.lifetimeGMVMinor ?? 0;
    const thisMonthGmvMinor = stats?.thisMonthGMVMinor ?? 0;
    const commissionMinor = Math.round(lifetimeGmvMinor * COMMISSION_RATE);
    const netLifetimeMinor = lifetimeGmvMinor - commissionMinor;
    const pendingPayoutMinor = payouts
      .filter((p) => p.status === "pending")
      .reduce((s, p) => s + p.amountMinor, 0);
    const paidOutMinor = payouts
      .filter((p) => p.status === "paid")
      .reduce((s, p) => s + p.amountMinor, 0);
    const availableMinor = Math.max(
      0,
      netLifetimeMinor - pendingPayoutMinor - paidOutMinor,
    );
    return {
      lifetimeGmvMinor,
      thisMonthGmvMinor,
      commissionMinor,
      netLifetimeMinor,
      pendingPayoutMinor,
      paidOutMinor,
      availableMinor,
      ordersTotal: stats?.ordersTotal ?? 0,
      ordersPending: stats?.ordersPending ?? 0,
      payouts,
      payoutThresholdMinor: 5000 * country.currency.minorPerMajor,
      holdDays: HOLD_DAYS,
    };
  }, [stats, payouts, country.currency.minorPerMajor]);

  const requestPayout = useCallback(
    (amountMinor: number): PayoutRequest | null => {
      if (amountMinor <= 0) return null;
      if (amountMinor > summary.availableMinor) return null;
      const bankLabel =
        application?.payoutBank ??
        country.bankAccount.bankNameExamples.split(",")[0]?.trim() ??
        "Bank";
      const bankLast4 = application?.payoutAccountLast4 ?? "0000";
      const req: PayoutRequest = {
        id: makePayoutId(),
        requestedAtIso: new Date().toISOString(),
        amountMinor,
        status: "pending",
        bankLabel,
        bankLast4,
        reference: makePayoutReference(),
      };
      setPayouts((prev) => [req, ...prev]);
      return req;
    },
    [
      application?.payoutBank,
      application?.payoutAccountLast4,
      country.bankAccount.bankNameExamples,
      summary.availableMinor,
      setPayouts,
    ],
  );

  const markPayoutPaid = useCallback(
    (id: string) => {
      setPayouts((prev) =>
        prev.map((p) =>
          p.id === id
            ? { ...p, status: "paid", paidAtIso: new Date().toISOString() }
            : p,
        ),
      );
    },
    [setPayouts],
  );

  return { summary, requestPayout, markPayoutPaid };
}
