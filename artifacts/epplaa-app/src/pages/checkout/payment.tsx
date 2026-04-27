import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  ChevronRight,
  CreditCard,
  Smartphone,
  Landmark,
  Banknote,
  Check,
  MessageCircle,
  Bell,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { isCodMethodId, isPickupOptionId } from "@/lib/countries";
import { useCheckout } from "@/lib/checkout-context";
import { useNotificationPrefs } from "@/lib/notification-prefs";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/page-header";
import { BottomActions, CheckoutSteps } from "./method";

function iconFor(key: string) {
  if (key === "credit-card") return CreditCard;
  if (key === "smartphone") return Smartphone;
  if (key === "landmark") return Landmark;
  return Banknote;
}

export default function CheckoutPayment() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { draft, set } = useCheckout();
  const [, setLocation] = useLocation();
  const [picked, setPicked] = useState<string | undefined>(
    draft.paymentMethodId,
  );
  const [prefs, setPrefs] = useNotificationPrefs();

  // Local mirror so toggles for this order don't surprise-mutate global prefs
  // until they confirm. We DO update the global prefs (per spec — channels are
  // long-lived) so future orders default the same way.
  const [waOn, setWaOn] = useState(prefs.whatsapp);
  const [smsOn, setSmsOn] = useState(prefs.sms);
  const [waNum, setWaNum] = useState(prefs.whatsappNumber ?? "");
  const [smsNum, setSmsNum] = useState(prefs.smsNumber ?? "");

  useEffect(() => {
    if (!draft.fulfillmentOptionId) setLocation("/checkout");
  }, [draft.fulfillmentOptionId, setLocation]);

  const subtle = isDark ? "text-white/55" : "text-stone-500";
  const inputClass = `w-full h-11 px-3 rounded-lg border text-sm ${
    isDark
      ? "bg-white/5 border-white/10 text-white placeholder-white/30"
      : "bg-white border-stone-400/55 text-stone-900 placeholder-stone-400"
  }`;

  function next() {
    if (!picked) return;
    setPrefs((p) => ({
      ...p,
      whatsapp: waOn,
      sms: smsOn,
      whatsappNumber: waNum,
      smsNumber: smsNum,
    }));
    set({
      paymentMethodId: picked,
      channelOverrides: {
        whatsapp: waOn,
        sms: smsOn,
        whatsappNumber: waNum,
        smsNumber: smsNum,
      },
    });
    setLocation("/checkout/review");
  }

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Payment & alerts" backHref="/checkout" />
      <div className="px-4 pb-32 space-y-4">
        <CheckoutSteps current={3} />

        <div>
          <h3 className={`text-xs font-bold uppercase tracking-wider mb-2 ${subtle}`}>
            How will you pay?
          </h3>
          <div className="space-y-2">
            {country.paymentMethods
              .filter((pm) => {
                // Pay-on-collection (cash) is only valid at pickup points; hide
                // it for door-delivery and other non-pickup fulfillment options
                // so users can't pick a method the order endpoint will reject.
                if (isCodMethodId(pm.id) && !isPickupOptionId(draft.fulfillmentOptionId)) {
                  return false;
                }
                return true;
              })
              .map((pm) => {
              const Icon = iconFor(pm.iconKey);
              const isPicked = picked === pm.id;
              return (
                <button
                  key={pm.id}
                  onClick={() => setPicked(pm.id)}
                  data-testid={`pay-${pm.id}`}
                  className={`w-full text-left flex items-center gap-3 rounded-xl border p-3 transition-colors ${
                    isPicked
                      ? isDark
                        ? "border-[#5BA3F5] bg-[#5BA3F5]/10"
                        : "border-[#1B2A4A] bg-[#1B2A4A]/10"
                      : isDark
                        ? "border-white/10 bg-white/5 hover:bg-white/10"
                        : "border-stone-400/35 bg-white hover:bg-stone-50"
                  }`}
                >
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                      isPicked
                        ? isDark
                          ? "bg-[#5BA3F5] text-black"
                          : "bg-[#1B2A4A] text-white"
                        : isDark
                          ? "bg-white/10 text-white/70"
                          : "bg-stone-200 text-stone-600"
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                  </div>
                  <p className="flex-1 font-bold text-sm">{pm.label}</p>
                  {isPicked && (
                    <Check
                      className={`w-5 h-5 ${
                        isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                      }`}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <h3 className={`text-xs font-bold uppercase tracking-wider mb-2 ${subtle}`}>
            Order updates
          </h3>
          <div
            className={`rounded-xl border overflow-hidden ${
              isDark
                ? "bg-white/5 border-white/10"
                : "bg-white border-stone-400/35"
            }`}
          >
            <div
              className={`flex items-center justify-between gap-3 p-3 border-b ${
                isDark ? "border-white/10" : "border-stone-200"
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center ${
                    isDark
                      ? "bg-white/10 text-white/80"
                      : "bg-stone-200 text-stone-700"
                  }`}
                >
                  <Bell className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <p className="font-bold text-sm">Push (in-app)</p>
                  <p className={`text-xs ${subtle}`}>
                    Always on for order updates
                  </p>
                </div>
              </div>
              <Switch checked disabled />
            </div>

            <div
              className={`flex flex-col gap-2 p-3 border-b ${
                isDark ? "border-white/10" : "border-stone-200"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center ${
                      isDark
                        ? "bg-white/10 text-white/80"
                        : "bg-stone-200 text-stone-700"
                    }`}
                  >
                    <MessageCircle className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="font-bold text-sm">WhatsApp</p>
                    <p className={`text-xs ${subtle}`}>
                      Order placed, ready, delivered
                    </p>
                  </div>
                </div>
                <Switch
                  checked={waOn}
                  onCheckedChange={setWaOn}
                  data-testid="switch-whatsapp"
                />
              </div>
              {waOn && (
                <input
                  value={waNum}
                  onChange={(e) => setWaNum(e.target.value)}
                  inputMode="tel"
                  placeholder="WhatsApp number e.g. +234 803 000 0000"
                  className={inputClass}
                  data-testid="input-whatsapp"
                />
              )}
            </div>

            <div className="flex flex-col gap-2 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center ${
                      isDark
                        ? "bg-white/10 text-white/80"
                        : "bg-stone-200 text-stone-700"
                    }`}
                  >
                    <Smartphone className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="font-bold text-sm">SMS</p>
                    <p className={`text-xs ${subtle}`}>
                      Useful for OTP / pickup code
                    </p>
                  </div>
                </div>
                <Switch
                  checked={smsOn}
                  onCheckedChange={setSmsOn}
                  data-testid="switch-sms"
                />
              </div>
              {smsOn && (
                <input
                  value={smsNum}
                  onChange={(e) => setSmsNum(e.target.value)}
                  inputMode="tel"
                  placeholder="SMS number e.g. +234 803 000 0000"
                  className={inputClass}
                  data-testid="input-sms"
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <BottomActions isDark={isDark}>
        <button
          onClick={() =>
            setLocation(
              draft.locationId ? "/checkout/location" : "/checkout/address",
            )
          }
          className={`flex-1 h-12 rounded-xl border font-bold ${
            isDark
              ? "border-white/20 text-white hover:bg-white/10"
              : "border-stone-400 text-stone-900 hover:bg-stone-200"
          }`}
        >
          Back
        </button>
        <button
          onClick={next}
          disabled={!picked}
          className={`flex-1 h-12 rounded-xl text-white font-bold flex items-center justify-center gap-1 disabled:opacity-40 ${
            isDark
              ? "bg-[#FF8855] hover:bg-[#FF6B35]"
              : "bg-[#E6502E] hover:bg-[#C4441E]"
          }`}
          data-testid="button-payment-next"
        >
          Review <ChevronRight className="w-4 h-4" />
        </button>
      </BottomActions>
    </div>
  );
}
