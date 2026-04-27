import { createContext, useContext, useMemo, ReactNode } from "react";
import { useLocalStorage } from "./use-local-storage";
import { OrderAddress } from "./orders-context";

export interface CheckoutDraft {
  fulfillmentOptionId?: string;
  locationId?: string;
  deliveryAddress?: OrderAddress;
  paymentMethodId?: string;
  channelOverrides?: {
    whatsapp?: boolean;
    sms?: boolean;
    whatsappNumber?: string;
    smsNumber?: string;
  };
}

interface CheckoutContextValue {
  draft: CheckoutDraft;
  set: (patch: Partial<CheckoutDraft>) => void;
  reset: () => void;
}

const CheckoutContext = createContext<CheckoutContextValue | null>(null);

export function CheckoutProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useLocalStorage<CheckoutDraft>(
    "epplaa-checkout-draft",
    {},
  );

  const value = useMemo<CheckoutContextValue>(
    () => ({
      draft,
      set: (patch) => setDraft((prev) => ({ ...prev, ...patch })),
      reset: () => setDraft({}),
    }),
    [draft, setDraft],
  );

  return (
    <CheckoutContext.Provider value={value}>
      {children}
    </CheckoutContext.Provider>
  );
}

export function useCheckout(): CheckoutContextValue {
  const ctx = useContext(CheckoutContext);
  if (!ctx)
    throw new Error("useCheckout must be used inside CheckoutProvider");
  return ctx;
}
