import { createContext, useContext, useMemo, ReactNode, useCallback } from "react";
import {
  useGetCheckoutDraft,
  usePutCheckoutDraft,
  useDeleteCheckoutDraft,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
  promoCode?: string;
}

interface CheckoutContextValue {
  draft: CheckoutDraft;
  set: (patch: Partial<CheckoutDraft>) => void;
  reset: () => void;
}

const CheckoutContext = createContext<CheckoutContextValue | null>(null);

export function CheckoutProvider({ children }: { children: ReactNode }) {
  const draftQuery = useGetCheckoutDraft();
  const qc = useQueryClient();
  const invalidate = useCallback(
    () => qc.invalidateQueries({ queryKey: ["/api/checkout-draft"] }),
    [qc],
  );
  const putDraft = usePutCheckoutDraft({ mutation: { onSuccess: invalidate } });
  const deleteDraft = useDeleteCheckoutDraft({ mutation: { onSuccess: invalidate } });

  const draft = (draftQuery.data ?? {}) as CheckoutDraft;

  const value = useMemo<CheckoutContextValue>(
    () => ({
      draft,
      set: (patch) => {
        const next = { ...draft, ...patch };
        // Optimistically write the merged draft into the cache so consumers
        // see updates instantly without waiting for the round-trip.
        qc.setQueryData(["/api/checkout-draft"], next);
        putDraft.mutate({ data: next as Record<string, unknown> });
      },
      reset: () => {
        qc.setQueryData(["/api/checkout-draft"], {});
        deleteDraft.mutate();
      },
    }),
    [draft, putDraft, deleteDraft, qc],
  );

  return <CheckoutContext.Provider value={value}>{children}</CheckoutContext.Provider>;
}

export function useCheckout(): CheckoutContextValue {
  const ctx = useContext(CheckoutContext);
  if (!ctx) throw new Error("useCheckout must be used inside CheckoutProvider");
  return ctx;
}
