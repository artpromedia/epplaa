import { useState } from "react";
import {
  CreditCard,
  Smartphone,
  Landmark,
  Banknote,
  Plus,
  Trash2,
  Check,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useLocalStorage } from "@/lib/use-local-storage";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/hooks/use-toast";

interface SavedPaymentMethod {
  id: string;
  countryCode: string;
  methodId: string;
  methodLabel: string;
  iconKey: string;
  detail: string;
}

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "credit-card": CreditCard,
  smartphone: Smartphone,
  landmark: Landmark,
  banknote: Banknote,
};

function detailHint(iconKey: string): {
  label: string;
  placeholder: string;
  formatter: (raw: string) => string;
} {
  switch (iconKey) {
    case "credit-card":
      return {
        label: "Card number",
        placeholder: "4242 4242 4242 4242",
        formatter: (raw) => {
          const digits = raw.replace(/\D/g, "").slice(-4);
          return digits ? `•••• ${digits}` : "";
        },
      };
    case "smartphone":
      return {
        label: "Mobile number",
        placeholder: "0801 234 5678",
        formatter: (raw) => raw.trim(),
      };
    case "landmark":
      return {
        label: "Bank account",
        placeholder: "GTBank • 0123456789",
        formatter: (raw) => raw.trim(),
      };
    case "banknote":
      return {
        label: "Note (optional)",
        placeholder: "Pay cash on collection",
        formatter: (raw) => raw.trim() || "Pay on collection",
      };
    default:
      return {
        label: "Detail",
        placeholder: "",
        formatter: (raw) => raw.trim(),
      };
  }
}

export default function PaymentMethods() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { toast } = useToast();
  const [methods, setMethods] = useLocalStorage<SavedPaymentMethod[]>(
    "epplaa-payment-methods",
    [],
  );

  const [showForm, setShowForm] = useState(false);
  const [methodId, setMethodId] = useState<string>(country.paymentMethods[0]?.id ?? "");
  const [detailRaw, setDetailRaw] = useState("");

  const selected = country.paymentMethods.find((m) => m.id === methodId);
  const hint = selected ? detailHint(selected.iconKey) : null;

  const cardClass = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";
  const subtleText = isDark ? "text-white/50" : "text-stone-500";
  const inputClass = `w-full px-3 py-2 rounded-lg border text-sm outline-none focus:ring-2 focus:ring-[#5BA3F5]/30 ${
    isDark
      ? "bg-black/40 border-white/10 text-white placeholder:text-white/30"
      : "bg-white border-stone-300 text-stone-900 placeholder:text-stone-400"
  }`;

  function reset() {
    setShowForm(false);
    setDetailRaw("");
    setMethodId(country.paymentMethods[0]?.id ?? "");
  }

  function save() {
    if (!selected || !hint) return;
    const detail = hint.formatter(detailRaw);
    if (!detail && selected.iconKey !== "banknote") {
      toast({
        title: "Add a detail",
        description: `Please enter your ${hint.label.toLowerCase()}.`,
      });
      return;
    }
    const next: SavedPaymentMethod = {
      id: `pm_${Date.now()}`,
      countryCode: country.code,
      methodId: selected.id,
      methodLabel: selected.label,
      iconKey: selected.iconKey,
      detail,
    };
    setMethods((prev) => [next, ...prev]);
    toast({ title: "Payment method saved" });
    reset();
  }

  function remove(id: string) {
    setMethods((prev) => prev.filter((m) => m.id !== id));
    toast({ title: "Removed" });
  }

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Payment Methods" />
      <div className="px-4 pb-24 space-y-6">
        <p className={`text-sm ${subtleText}`}>
          Saved methods for {country.flag} {country.name}. Switch country in your
          profile to manage methods elsewhere.
        </p>

        {methods.length === 0 && !showForm && (
          <div
            className={`rounded-xl border p-6 text-center ${cardClass}`}
          >
            <CreditCard className={`w-8 h-8 mx-auto mb-2 ${subtleText}`} />
            <p className="font-medium mb-1">No saved methods yet</p>
            <p className={`text-sm ${subtleText}`}>
              Add a card, mobile money, or bank account for faster checkout.
            </p>
          </div>
        )}

        {methods.length > 0 && (
          <div className={`rounded-xl border overflow-hidden ${cardClass}`}>
            {methods.map((m, idx) => {
              const Icon = ICONS[m.iconKey] ?? CreditCard;
              const flag =
                m.countryCode === country.code
                  ? ""
                  : ` · ${m.countryCode}`;
              return (
                <div
                  key={m.id}
                  className={`flex items-center justify-between p-4 ${
                    idx > 0
                      ? isDark
                        ? "border-t border-white/10"
                        : "border-t border-stone-200"
                      : ""
                  }`}
                  data-testid={`payment-method-${m.id}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                        isDark ? "bg-white/10" : "bg-stone-100"
                      }`}
                    >
                      <Icon
                        className={`w-5 h-5 ${
                          isDark ? "text-white/80" : "text-stone-700"
                        }`}
                      />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium truncate">
                        {m.methodLabel}
                        {flag && (
                          <span className={`ml-1 text-xs ${subtleText}`}>
                            {flag}
                          </span>
                        )}
                      </p>
                      <p className={`text-sm truncate ${subtleText}`}>
                        {m.detail}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => remove(m.id)}
                    className={`p-2 rounded-full shrink-0 ${
                      isDark
                        ? "hover:bg-white/10 text-white/60"
                        : "hover:bg-stone-200 text-stone-500"
                    }`}
                    aria-label="Remove"
                    data-testid={`remove-payment-${m.id}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {!showForm ? (
          <button
            onClick={() => setShowForm(true)}
            className={`w-full flex items-center justify-center gap-2 py-3 rounded-full font-bold ${
              isDark
                ? "bg-[#5BA3F5] text-black"
                : "bg-[#1B2A4A] text-white"
            }`}
            data-testid="button-add-payment"
          >
            <Plus className="w-5 h-5" />
            Add payment method
          </button>
        ) : (
          <div className={`rounded-xl border p-4 space-y-4 ${cardClass}`}>
            <div>
              <label className="block text-sm font-bold mb-2">
                Method type
              </label>
              <div className="grid grid-cols-1 gap-2">
                {country.paymentMethods.map((m) => {
                  const Icon = ICONS[m.iconKey] ?? CreditCard;
                  const active = m.id === methodId;
                  return (
                    <button
                      key={m.id}
                      onClick={() => setMethodId(m.id)}
                      className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                        active
                          ? isDark
                            ? "bg-[#5BA3F5]/10 border-[#5BA3F5]/30"
                            : "bg-[#1B2A4A]/10 border-[#1B2A4A]/30"
                          : isDark
                            ? "bg-black/40 border-white/10 hover:bg-white/5"
                            : "bg-white border-stone-300 hover:bg-stone-50"
                      }`}
                      data-testid={`select-method-${m.id}`}
                    >
                      <Icon
                        className={`w-5 h-5 ${
                          active
                            ? isDark
                              ? "text-[#5BA3F5]"
                              : "text-[#1B2A4A]"
                            : isDark
                              ? "text-white/70"
                              : "text-stone-600"
                        }`}
                      />
                      <span className="font-medium">{m.label}</span>
                      {active && (
                        <Check
                          className={`w-4 h-4 ml-auto ${
                            isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                          }`}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {hint && (
              <div>
                <label className="block text-sm font-bold mb-2">
                  {hint.label}
                </label>
                <input
                  type="text"
                  value={detailRaw}
                  onChange={(e) => setDetailRaw(e.target.value)}
                  placeholder={hint.placeholder}
                  className={inputClass}
                  data-testid="input-payment-detail"
                />
                {selected?.iconKey === "credit-card" && (
                  <p className={`text-xs mt-1 ${subtleText}`}>
                    We only store the last 4 digits on this device.
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button
                onClick={reset}
                className={`flex-1 py-2 rounded-full font-medium ${
                  isDark
                    ? "bg-white/10 hover:bg-white/15 text-white"
                    : "bg-stone-200 hover:bg-stone-300 text-stone-900"
                }`}
                data-testid="button-cancel-payment"
              >
                Cancel
              </button>
              <button
                onClick={save}
                className={`flex-1 py-2 rounded-full font-bold ${
                  isDark
                    ? "bg-[#5BA3F5] text-black"
                    : "bg-[#1B2A4A] text-white"
                }`}
                data-testid="button-save-payment"
              >
                Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
