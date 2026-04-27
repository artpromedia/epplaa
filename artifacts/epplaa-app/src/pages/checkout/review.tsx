import { useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { Package, MapPin, Truck } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useCart } from "@/lib/cart-context";
import { useCheckout } from "@/lib/checkout-context";
import {
  generateOTP,
  Order,
  OrderFulfillment,
  useOrders,
} from "@/lib/orders-context";
import { getLocationById } from "@/lib/fulfillment-locations";
import { formatPrice } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { BottomActions, CheckoutSteps } from "./method";

export default function CheckoutReview() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { resolved, subtotalMinor, clear } = useCart();
  const { draft, reset: resetCheckout } = useCheckout();
  const { add: addOrder } = useOrders();
  const [, setLocation] = useLocation();

  const fOpt = country.fulfillmentOptions.find(
    (o) => o.id === draft.fulfillmentOptionId,
  );
  const pm = country.paymentMethods.find((p) => p.id === draft.paymentMethodId);
  const loc = draft.locationId ? getLocationById(draft.locationId) : undefined;
  const addr = draft.deliveryAddress;

  const isHomeDeliveryOpt = useMemo(
    () =>
      !!fOpt &&
      (fOpt.id.includes("home") ||
        fOpt.id.includes("door") ||
        fOpt.id.includes("livraison")),
    [fOpt],
  );

  // Strict guards: any missing prerequisite kicks the user back to the right step.
  useEffect(() => {
    if (resolved.length === 0) {
      setLocation("/cart");
      return;
    }
    if (!fOpt) {
      setLocation("/checkout");
      return;
    }
    if (isHomeDeliveryOpt && !addr) {
      setLocation("/checkout/address");
      return;
    }
    if (!isHomeDeliveryOpt && !loc) {
      setLocation("/checkout/location");
      return;
    }
    if (!pm) {
      setLocation("/checkout/payment");
      return;
    }
  }, [resolved.length, fOpt, isHomeDeliveryOpt, addr, loc, pm, setLocation]);

  const shipping = fOpt?.feeMinor ?? 0;
  const total = subtotalMinor + shipping;

  const subtle = isDark ? "text-white/55" : "text-stone-500";
  const cardBorder = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";

  const isHomeDelivery = isHomeDeliveryOpt;

  function placeOrder() {
    if (resolved.length === 0) return;
    if (!fOpt || !pm) return;
    if (isHomeDelivery && !addr) return;
    if (!isHomeDelivery && !loc) return;

    const fulfillment: OrderFulfillment = {
      optionId: fOpt.id,
      optionLabel: fOpt.label,
      feeMinor: fOpt.feeMinor,
      ...(loc
        ? {
            locationId: loc.id,
            locationName: loc.name,
            locationAddress: loc.addressLine,
          }
        : {}),
      ...(addr ? { deliveryAddress: addr } : {}),
    };

    const draftOrder: Omit<Order, "id" | "createdAtIso"> = {
      status: isHomeDelivery ? "out_for_delivery" : "ready_for_pickup",
      countryCode: country.code,
      currencyCode: country.currency.code,
      items: resolved.map((it) => ({
        productId: it.productId,
        title: it.title,
        priceMinor: it.priceMinor,
        qty: it.qty,
        image: it.image,
      })),
      fulfillment,
      payment: {
        methodId: pm.id,
        methodLabel: pm.label,
      },
      notificationPrefs: {
        push: true,
        whatsapp: !!draft.channelOverrides?.whatsapp,
        sms: !!draft.channelOverrides?.sms,
        whatsappNumber: draft.channelOverrides?.whatsappNumber,
        smsNumber: draft.channelOverrides?.smsNumber,
      },
      totalsMinor: {
        subtotal: subtotalMinor,
        shipping,
        total,
      },
      etaLabel: fOpt.etaLabel,
      ...(isHomeDelivery ? {} : { pickupOTP: generateOTP() }),
    };

    const order = addOrder(draftOrder);
    clear();
    resetCheckout();
    setLocation(`/checkout/success/${order.id}`);
  }

  function methodIcon() {
    if (!fOpt) return Package;
    if (fOpt.id.includes("box") || fOpt.id.includes("locker")) return Package;
    if (isHomeDelivery) return Truck;
    return MapPin;
  }
  const Icon = methodIcon();

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Review order" backHref="/checkout/payment" />
      <div className="px-4 pb-32 space-y-4">
        <CheckoutSteps current={4} />

        <Section title="Items" subtle={subtle}>
          <div className={`rounded-xl border overflow-hidden ${cardBorder}`}>
            {resolved.map((it, i) => (
              <div
                key={it.productId}
                className={`flex gap-3 p-3 ${
                  i < resolved.length - 1
                    ? isDark
                      ? "border-b border-white/10"
                      : "border-b border-stone-200"
                    : ""
                }`}
              >
                <div className="w-12 h-12 rounded-md overflow-hidden bg-stone-200 shrink-0">
                  <img
                    src={it.image}
                    alt={it.title}
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold leading-snug line-clamp-2">
                    {it.title}
                  </p>
                  <p className={`text-xs mt-0.5 ${subtle}`}>
                    Qty {it.qty} · {formatPrice(it.priceMinor, country)}
                  </p>
                </div>
                <p className="text-sm font-bold shrink-0">
                  {formatPrice(it.lineTotalMinor, country)}
                </p>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Delivery" subtle={subtle}>
          <div className={`rounded-xl border p-3 ${cardBorder}`}>
            <div className="flex items-start gap-3">
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                  isDark
                    ? "bg-[#5BA3F5] text-black"
                    : "bg-[#1B2A4A] text-white"
                }`}
              >
                <Icon className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <p className="font-bold text-sm">{fOpt?.label}</p>
                {loc && (
                  <>
                    <p className={`text-xs mt-0.5 ${subtle}`}>{loc.name}</p>
                    <p className={`text-xs ${subtle}`}>{loc.addressLine}</p>
                  </>
                )}
                {addr && (
                  <>
                    <p className={`text-xs mt-0.5 ${subtle}`}>{addr.label}</p>
                    <p className={`text-xs ${subtle}`}>
                      {addr.street}, {addr.area}, {addr.city}
                    </p>
                    {addr.notes && (
                      <p className={`text-xs italic mt-1 ${subtle}`}>
                        Note: {addr.notes}
                      </p>
                    )}
                  </>
                )}
                <p className={`text-[11px] mt-1 ${subtle}`}>
                  ETA {fOpt?.etaLabel.toLowerCase()}
                </p>
              </div>
            </div>
          </div>
        </Section>

        <Section title="Payment" subtle={subtle}>
          <div className={`rounded-xl border p-3 ${cardBorder}`}>
            <p className="font-bold text-sm">{pm?.label}</p>
            <p className={`text-xs mt-0.5 ${subtle}`}>
              You'll be charged {formatPrice(total, country)} once you confirm.
            </p>
          </div>
        </Section>

        <Section title="Totals" subtle={subtle}>
          <div className={`rounded-xl border p-3 space-y-2 ${cardBorder}`}>
            <Row
              label={`Subtotal (${resolved.length} item${
                resolved.length === 1 ? "" : "s"
              })`}
              value={formatPrice(subtotalMinor, country)}
              subtle={subtle}
            />
            <Row
              label="Shipping"
              value={
                shipping === 0 ? "FREE" : formatPrice(shipping, country)
              }
              subtle={subtle}
            />
            <div
              className={`pt-2 border-t flex items-center justify-between ${
                isDark ? "border-white/10" : "border-stone-200"
              }`}
            >
              <span className="font-bold">Total</span>
              <span
                className="text-xl font-black"
                data-testid="text-review-total"
              >
                {formatPrice(total, country)}
              </span>
            </div>
          </div>
        </Section>
      </div>

      <BottomActions isDark={isDark}>
        <button
          onClick={() => setLocation("/checkout/payment")}
          className={`flex-1 h-12 rounded-xl border font-bold ${
            isDark
              ? "border-white/20 text-white hover:bg-white/10"
              : "border-stone-400 text-stone-900 hover:bg-stone-200"
          }`}
        >
          Back
        </button>
        <button
          onClick={placeOrder}
          className={`flex-[1.4] h-12 rounded-xl text-white font-black ${
            isDark
              ? "bg-gradient-to-r from-[#FF8855] to-[#FF6B35] shadow-[0_0_20px_rgba(255,136,85,0.4)]"
              : "bg-gradient-to-r from-[#E6502E] to-[#C4441E] shadow-md"
          }`}
          data-testid="button-place-order"
        >
          Place order · {formatPrice(total, country)}
        </button>
      </BottomActions>
    </div>
  );
}

function Section({
  title,
  subtle,
  children,
}: {
  title: string;
  subtle: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3
        className={`text-xs font-bold uppercase tracking-wider mb-2 ${subtle}`}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({
  label,
  value,
  subtle,
}: {
  label: string;
  value: string;
  subtle: string;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={subtle}>{label}</span>
      <span className="font-bold">{value}</span>
    </div>
  );
}
