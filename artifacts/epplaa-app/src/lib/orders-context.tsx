import { createContext, useCallback, useContext, useMemo, ReactNode } from "react";
import { useLocalStorage } from "./use-local-storage";
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
    total: number;
  };
  pickupOTP?: string;
  etaLabel: string;
}

interface OrdersContextValue {
  orders: Order[];
  add: (order: Omit<Order, "id" | "createdAtIso">) => Order;
  getById: (id: string) => Order | undefined;
  cancel: (id: string) => void;
}

const OrdersContext = createContext<OrdersContextValue | null>(null);

function makeOrderId(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `EP-${ts}${rand}`;
}

export function generateOTP(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

export function OrdersProvider({ children }: { children: ReactNode }) {
  const [orders, setOrders] = useLocalStorage<Order[]>("epplaa-orders", []);

  const add = useCallback<OrdersContextValue["add"]>(
    (draft) => {
      const order: Order = {
        ...draft,
        id: makeOrderId(),
        createdAtIso: new Date().toISOString(),
      };
      setOrders((prev) => [order, ...prev]);
      return order;
    },
    [setOrders],
  );

  const getById = useCallback(
    (id: string) => orders.find((o) => o.id === id),
    [orders],
  );

  const cancel = useCallback(
    (id: string) =>
      setOrders((prev) =>
        prev.map((o) => (o.id === id ? { ...o, status: "cancelled" } : o)),
      ),
    [setOrders],
  );

  const value = useMemo<OrdersContextValue>(
    () => ({ orders, add, getById, cancel }),
    [orders, add, getById, cancel],
  );

  return (
    <OrdersContext.Provider value={value}>{children}</OrdersContext.Provider>
  );
}

export function useOrders(): OrdersContextValue {
  const ctx = useContext(OrdersContext);
  if (!ctx) throw new Error("useOrders must be used inside OrdersProvider");
  return ctx;
}
