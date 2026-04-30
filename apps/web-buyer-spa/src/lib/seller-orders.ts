// Seller-side fulfillment queue, now backed by the server.

import { useCallback, useMemo } from "react";
import {
  useListSellerOrders,
  useTransitionSellerOrder,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { CountryCode } from "./countries";

export type SellerOrderStatus =
  | "new"
  | "packing"
  | "ready"
  | "in_transit"
  | "delivered"
  | "cancelled";

export interface SellerOrder {
  id: string;
  buyerName: string;
  buyerHandle: string;
  buyerAvatar?: string;
  productTitle: string;
  productImage: string;
  qty: number;
  unitPriceMinor: number;
  countryCode: CountryCode;
  currencyCode: string;
  status: SellerOrderStatus;
  fulfillmentLabel: string;
  pickupOTP?: string;
  pickupLocationName?: string;
  placedAtIso: string;
  shippedAtIso?: string;
  deliveredAtIso?: string;
  trackingNote?: string;
}

export function useSellerOrders() {
  const query = useListSellerOrders();
  const qc = useQueryClient();
  const invalidate = useCallback(
    () => qc.invalidateQueries({ queryKey: ["/api/seller/orders"] }),
    [qc],
  );
  const transitionMut = useTransitionSellerOrder({ mutation: { onSuccess: invalidate } });

  const orders = useMemo<SellerOrder[]>(
    () =>
      (query.data ?? []).map((r) => ({
        id: r.id,
        buyerName: r.buyerName,
        buyerHandle: r.buyerHandle,
        buyerAvatar: r.buyerAvatar ?? undefined,
        productTitle: r.productTitle,
        productImage: r.productImage,
        qty: r.qty,
        unitPriceMinor: r.unitPriceMinor,
        countryCode: r.countryCode as CountryCode,
        currencyCode: r.currencyCode,
        status: r.status as SellerOrderStatus,
        fulfillmentLabel: r.fulfillmentLabel,
        pickupOTP: r.pickupOtp ?? undefined,
        pickupLocationName: r.pickupLocationName ?? undefined,
        placedAtIso: r.placedAtIso,
        shippedAtIso: r.shippedAtIso ?? undefined,
        deliveredAtIso: r.deliveredAtIso ?? undefined,
        trackingNote: r.trackingNote ?? undefined,
      })),
    [query.data],
  );

  function transition(id: string, status: SellerOrderStatus, trackingNote?: string) {
    transitionMut.mutate({
      sellerOrderId: id,
      data: { status, ...(trackingNote ? { trackingNote } : {}) },
    });
  }

  function markPacking(id: string, note?: string) {
    transition(id, "packing", note ?? "Picking + packing");
  }
  function markReady(id: string) {
    transition(id, "ready", "Awaiting courier pickup at your hub");
  }
  function markInTransit(id: string, note: string) {
    transition(id, "in_transit", note);
  }
  function verifyPickup(id: string, otpEntered: string): boolean {
    const target = orders.find((o) => o.id === id);
    if (!target?.pickupOTP) return false;
    if (otpEntered.trim() !== target.pickupOTP) return false;
    transition(id, "delivered", "Buyer collected with OTP");
    return true;
  }
  function markDelivered(id: string) {
    transition(id, "delivered", "Marked delivered");
  }
  function reset() {
    /* server-truth, nothing to reset client-side */
  }

  return { orders, markPacking, markReady, markInTransit, verifyPickup, markDelivered, reset };
}

export const SELLER_ORDER_STATUS_LABEL: Record<SellerOrderStatus, string> = {
  new: "New",
  packing: "Packing",
  ready: "Ready for pickup",
  in_transit: "In transit",
  delivered: "Delivered",
  cancelled: "Cancelled",
};
