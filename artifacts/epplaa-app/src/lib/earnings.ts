import { useCallback, useMemo } from "react";
import {
  useGetSellerEarnings,
  useRequestSellerPayout,
  useMarkSellerPayoutPaid,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Country } from "./countries";

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

export function useSellerEarnings(country: Country): {
  summary: EarningsSummary;
  requestPayout: (amountMinor: number) => PayoutRequest | null;
  markPayoutPaid: (id: string) => void;
} {
  const query = useGetSellerEarnings({ countryCode: country.code });
  const qc = useQueryClient();
  const invalidate = useCallback(
    () =>
      qc.invalidateQueries({
        queryKey: ["/api/seller/earnings", { countryCode: country.code }],
      }),
    [qc, country.code],
  );
  const requestMut = useRequestSellerPayout({ mutation: { onSuccess: invalidate } });
  const markPaidMut = useMarkSellerPayoutPaid({ mutation: { onSuccess: invalidate } });

  const summary = useMemo<EarningsSummary>(() => {
    const data = query.data;
    if (!data) {
      return {
        lifetimeGmvMinor: 0,
        thisMonthGmvMinor: 0,
        commissionMinor: 0,
        netLifetimeMinor: 0,
        pendingPayoutMinor: 0,
        paidOutMinor: 0,
        availableMinor: 0,
        ordersTotal: 0,
        ordersPending: 0,
        payouts: [],
        payoutThresholdMinor: 5000 * country.currency.minorPerMajor,
        holdDays: 3,
      };
    }
    return {
      lifetimeGmvMinor: data.lifetimeGmvMinor,
      thisMonthGmvMinor: data.thisMonthGmvMinor,
      commissionMinor: data.commissionMinor,
      netLifetimeMinor: data.netLifetimeMinor,
      pendingPayoutMinor: data.pendingPayoutMinor,
      paidOutMinor: data.paidOutMinor,
      availableMinor: data.availableMinor,
      ordersTotal: data.ordersTotal,
      ordersPending: data.ordersPending,
      payoutThresholdMinor: data.payoutThresholdMinor,
      holdDays: data.holdDays,
      payouts: (data.payouts ?? []).map((p) => ({
        id: p.id,
        requestedAtIso: p.requestedAtIso,
        amountMinor: p.amountMinor,
        status: p.status as PayoutRequest["status"],
        bankLabel: p.bankLabel,
        bankLast4: p.bankLast4,
        reference: p.reference,
        paidAtIso: p.paidAtIso ?? undefined,
      })),
    };
  }, [query.data, country.currency.minorPerMajor]);

  function requestPayout(amountMinor: number): PayoutRequest | null {
    if (amountMinor <= 0 || amountMinor > summary.availableMinor) return null;
    requestMut.mutate({ data: { amountMinor } });
    return {
      id: `tmp_${Date.now()}`,
      requestedAtIso: new Date().toISOString(),
      amountMinor,
      status: "pending",
      bankLabel: "Bank",
      bankLast4: "0000",
      reference: "PENDING",
    };
  }
  function markPayoutPaid(id: string) {
    markPaidMut.mutate({ payoutId: id });
  }

  return { summary, requestPayout, markPayoutPaid };
}
