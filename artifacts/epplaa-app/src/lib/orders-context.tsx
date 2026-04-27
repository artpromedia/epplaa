import { createContext, useCallback, useContext, useMemo, ReactNode } from "react";
import {
  useCancelOrder,
  useListOrders,
  usePlaceOrder,
  type Order as ApiOrder,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { CountryCode } from "./countries";

export type OrderStatus =
  | "placed"
  | "ready_for_pickup"
  | "out_for_delivery"
  | "delivered"
  | "cancelled";

export interface OrderItem {
  productId: string;
  title: string;
  priceMinor: number;
  qty: number;
  image?: string;
}

export interface OrderAddress {
  label: string;
  street: string;
  area: string;
  city: string;
  notes?: string;
  lat: number;
  lng: number;
  confidencePct: number;
}

export interface OrderFulfillment {
  optionId: string;
  optionLabel: string;
  feeMinor: number;
  locationId?: string;
  locationName?: string;
  locationAddress?: string;
  deliveryAddress?: OrderAddress;
}

export interface OrderPayment {
  methodId: string;
  methodLabel: string;
}

export interface OrderNotificationPrefs {
  push: boolean;
  whatsapp: boolean;
  sms: boolean;
  whatsappNumber?: string;
  smsNumber?: string;
}

export interface Order {
  id: string;
  createdAtIso: string;
  status: OrderStatus;
  countryCode: CountryCode;
  currencyCode: string;
  items: OrderItem[];
  fulfillment: OrderFulfillment;
  payment: OrderPayment;
  notificationPrefs: OrderNotificationPrefs;
  totalsMinor: {
    subtotal: number;
    shipping: number;
    discount?: number;
    shippingDiscount?: number;
    total: number;
  };
  promo?: {
    code: string;
    label: string;
  };
  pickupOTP?: string;
  etaLabel: string;
}

interface OrdersContextValue {
  orders: Order[];
  add: (order: Omit<Order, "id" | "createdAtIso">) => Promise<Order>;
  getById: (id: string) => Order | undefined;
  cancel: (id: string) => Promise<void>;
}

const OrdersContext = createContext<OrdersContextValue | null>(null);

export function generateOTP(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function fromApi(o: ApiOrder): Order {
  return {
    id: o.id,
    createdAtIso: o.createdAtIso,
    status: o.status as OrderStatus,
    countryCode: o.countryCode as CountryCode,
    currencyCode: o.currencyCode,
    items: o.items as unknown as OrderItem[],
    fulfillment: o.fulfillment as unknown as OrderFulfillment,
    payment: o.payment as unknown as OrderPayment,
    notificationPrefs: o.notificationPrefs as unknown as OrderNotificationPrefs,
    totalsMinor: o.totalsMinor as unknown as Order["totalsMinor"],
    promo: o.promo as unknown as Order["promo"] | undefined,
    pickupOTP: o.pickupOtp ?? undefined,
    etaLabel: o.etaLabel,
  };
}

export function OrdersProvider({ children }: { children: ReactNode }) {
  const ordersQuery = useListOrders();
  const qc = useQueryClient();
  const placeOrder = usePlaceOrder({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["/api/orders"] });
        qc.invalidateQueries({ queryKey: ["/api/cart"] });
        qc.invalidateQueries({ queryKey: ["/api/checkout-draft"] });
      },
    },
  });
  const cancelOrder = useCancelOrder({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/orders"] }),
    },
  });

  const orders = useMemo<Order[]>(
    () => (ordersQuery.data ?? []).map(fromApi),
    [ordersQuery.data],
  );

  const add = useCallback<OrdersContextValue["add"]>(
    async (draft) => {
      const result = await placeOrder.mutateAsync({
        data: { ...draft } as Record<string, unknown>,
      });
      return fromApi(result);
    },
    [placeOrder],
  );

  const getById = useCallback(
    (id: string) => orders.find((o) => o.id === id),
    [orders],
  );

  const cancel = useCallback<OrdersContextValue["cancel"]>(
    async (id) => {
      await cancelOrder.mutateAsync({ orderId: id });
    },
    [cancelOrder],
  );

  const value = useMemo<OrdersContextValue>(
    () => ({ orders, add, getById, cancel }),
    [orders, add, getById, cancel],
  );

  return <OrdersContext.Provider value={value}>{children}</OrdersContext.Provider>;
}

export function useOrders(): OrdersContextValue {
  const ctx = useContext(OrdersContext);
  if (!ctx) throw new Error("useOrders must be used inside OrdersProvider");
  return ctx;
}
