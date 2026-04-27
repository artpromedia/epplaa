import { useState } from "react";
import {
  Bell,
  Megaphone,
  Package,
  Sparkles,
  Trash,
  LogOut,
  Monitor,
  MessageCircle,
  Smartphone,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useLocalStorage } from "@/lib/use-local-storage";
import {
  NotificationPrefs,
  DEFAULT_NOTIFICATIONS,
} from "@/lib/notification-prefs";
import { PageHeader } from "@/components/page-header";
import { ThemeToggle } from "@/components/theme-toggle";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";

const EPPLAA_KEYS = [
  "epplaa-payment-methods",
  "epplaa-addresses",
  "epplaa-notifications",
  "epplaa-country",
  "epplaa-theme",
  "epplaa-seller-status",
  "epplaa-seller-tier",
  "epplaa-app-mode",
  "epplaa-seller-application",
  "epplaa-seller-stats",
  "epplaa-seller-listings",
  "epplaa-cart",
  "epplaa-orders",
  "epplaa-checkout-draft",
  "epplaa-wishlist",
  "epplaa-follows",
  "epplaa-reviews",
  "epplaa-recently-viewed",
  "epplaa-recent-searches",
  "epplaa-payouts",
  "epplaa-seller-orders",
  "epplaa-seller-streams",
  "epplaa-returns",
  "epplaa-wallet-txns",
  "epplaa-safety-reports",
  "epplaa-safety-blocked",
  "epplaa-onboarding",
  "epplaa-referral-code",
];

export default function Settings() {
  const { resolvedTheme, theme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { toast } = useToast();
  const [prefs, setPrefs] = useLocalStorage<NotificationPrefs>(
    "epplaa-notifications",
    DEFAULT_NOTIFICATIONS,
  );
  const [confirmingClear, setConfirmingClear] = useState(false);

  const cardClass = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";
  const subtleText = isDark ? "text-white/50" : "text-stone-500";
  const sectionLabel = `text-sm font-bold mb-3 uppercase tracking-wider ${
    isDark ? "text-white/40" : "text-stone-400"
  }`;

  const themeLabel =
    theme === "system"
      ? `System (${resolvedTheme === "dark" ? "Dark" : "Light"})`
      : theme === "dark"
        ? "Dark"
        : "Light";

  function clearLocalData() {
    EPPLAA_KEYS.forEach((k) => window.localStorage.removeItem(k));
    toast({
      title: "Local data cleared",
      description: "Reloading to reset state...",
    });
    setTimeout(() => window.location.reload(), 600);
  }

  function signOut() {
    toast({
      title: "Signed out",
      description: "Account auth ships in v2. This is a preview.",
    });
  }

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Settings" />
      <div className="px-4 pb-24 space-y-6">
        <section>
          <h3 className={sectionLabel}>Notifications</h3>
          <div className={`rounded-xl border overflow-hidden ${cardClass}`}>
            <SettingRow
              icon={<Sparkles className="w-5 h-5" />}
              isDark={isDark}
              title="Live drops"
              description="Get pinged when a creator you follow goes live."
              control={
                <Switch
                  checked={prefs.liveDrops}
                  onCheckedChange={(v) =>
                    setPrefs((p) => ({ ...p, liveDrops: v }))
                  }
                  data-testid="switch-live-drops"
                />
              }
              border
            />
            <SettingRow
              icon={<Package className="w-5 h-5" />}
              isDark={isDark}
              title="Order updates"
              description="Shipping, delivery, and pickup-ready alerts."
              control={
                <Switch
                  checked={prefs.orderUpdates}
                  onCheckedChange={(v) =>
                    setPrefs((p) => ({ ...p, orderUpdates: v }))
                  }
                  data-testid="switch-order-updates"
                />
              }
              border
            />
            <SettingRow
              icon={<Megaphone className="w-5 h-5" />}
              isDark={isDark}
              title="Promos & marketing"
              description="Deals, drops, and Epplaa news."
              control={
                <Switch
                  checked={prefs.marketing}
                  onCheckedChange={(v) =>
                    setPrefs((p) => ({ ...p, marketing: v }))
                  }
                  data-testid="switch-marketing"
                />
              }
              border
            />
            <SettingRow
              icon={<MessageCircle className="w-5 h-5" />}
              isDark={isDark}
              title="WhatsApp updates"
              description={
                prefs.whatsappNumber
                  ? `On ${prefs.whatsappNumber}`
                  : "Default channel for order updates."
              }
              control={
                <Switch
                  checked={prefs.whatsapp}
                  onCheckedChange={(v) =>
                    setPrefs((p) => ({ ...p, whatsapp: v }))
                  }
                  data-testid="switch-whatsapp"
                />
              }
              border
            />
            <SettingRow
              icon={<Smartphone className="w-5 h-5" />}
              isDark={isDark}
              title="SMS updates"
              description={
                prefs.smsNumber
                  ? `On ${prefs.smsNumber}`
                  : "Useful for OTP / pickup codes."
              }
              control={
                <Switch
                  checked={prefs.sms}
                  onCheckedChange={(v) =>
                    setPrefs((p) => ({ ...p, sms: v }))
                  }
                  data-testid="switch-sms"
                />
              }
            />
          </div>
        </section>

        <section>
          <h3 className={sectionLabel}>Display</h3>
          <div className={`rounded-xl border overflow-hidden ${cardClass}`}>
            <SettingRow
              icon={<Monitor className="w-5 h-5" />}
              isDark={isDark}
              title="Appearance"
              description={themeLabel}
              control={<ThemeToggle />}
            />
          </div>
        </section>

        <section>
          <h3 className={sectionLabel}>Region</h3>
          <div
            className={`rounded-xl border p-4 ${cardClass}`}
            data-testid="settings-region"
          >
            <p className="font-medium mb-1">
              <span className="text-2xl mr-2 leading-none align-middle">
                {country.flag}
              </span>
              {country.name}
            </p>
            <p className={`text-sm ${subtleText}`}>
              {country.currency.code} ({country.currency.symbol.trim()}) ·{" "}
              {country.primaryCity}
            </p>
            <p className={`text-xs mt-2 ${subtleText}`}>
              Change country from your Profile screen.
            </p>
          </div>
        </section>

        <section>
          <h3 className={sectionLabel}>Account</h3>
          <div className={`rounded-xl border overflow-hidden ${cardClass}`}>
            <button
              onClick={() => setConfirmingClear(true)}
              className={`w-full flex items-center gap-3 p-4 text-left ${
                isDark
                  ? "hover:bg-white/5 border-b border-white/10"
                  : "hover:bg-stone-50 border-b border-stone-200"
              }`}
              data-testid="button-clear-data"
            >
              <Trash
                className={`w-5 h-5 ${
                  isDark ? "text-white/70" : "text-stone-500"
                }`}
              />
              <div className="min-w-0">
                <p className="font-medium">Clear local data</p>
                <p className={`text-sm ${subtleText}`}>
                  Removes saved methods, addresses, and preferences.
                </p>
              </div>
            </button>
            <button
              onClick={signOut}
              className={`w-full flex items-center gap-3 p-4 text-left ${
                isDark ? "hover:bg-white/5" : "hover:bg-stone-50"
              }`}
              data-testid="button-sign-out"
            >
              <LogOut
                className={`w-5 h-5 ${
                  isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                }`}
              />
              <span
                className={`font-medium ${
                  isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                }`}
              >
                Sign out
              </span>
            </button>
          </div>
        </section>

        <section>
          <h3 className={sectionLabel}>About</h3>
          <div className={`rounded-xl border p-4 ${cardClass}`}>
            <div className="flex items-center gap-2">
              <Bell
                className={`w-4 h-4 ${
                  isDark ? "text-white/60" : "text-stone-500"
                }`}
              />
              <span className="font-medium">Epplaa</span>
              <span className={`text-sm ${subtleText}`}>v1.0 · preview</span>
            </div>
          </div>
        </section>
      </div>

      {confirmingClear && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6">
          <div
            className={`max-w-sm w-full rounded-2xl border p-6 ${
              isDark
                ? "bg-[#171C30] border-white/10 text-white"
                : "bg-white border-stone-300 text-stone-900"
            }`}
          >
            <h4 className="text-lg font-bold mb-2">Clear local data?</h4>
            <p className={`text-sm mb-5 ${subtleText}`}>
              This removes saved payment methods, addresses, notification
              preferences, country, and theme from this device. The page will
              reload.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmingClear(false)}
                className={`flex-1 py-2 rounded-full font-medium ${
                  isDark
                    ? "bg-white/10 hover:bg-white/15"
                    : "bg-stone-200 hover:bg-stone-300"
                }`}
                data-testid="button-cancel-clear"
              >
                Cancel
              </button>
              <button
                onClick={clearLocalData}
                className={`flex-1 py-2 rounded-full font-bold ${
                  isDark
                    ? "bg-[#FF8855] text-white"
                    : "bg-[#E6502E] text-white"
                }`}
                data-testid="button-confirm-clear"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SettingRow({
  icon,
  isDark,
  title,
  description,
  control,
  border,
}: {
  icon: React.ReactNode;
  isDark: boolean;
  title: string;
  description?: string;
  control?: React.ReactNode;
  border?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 p-4 ${
        border
          ? isDark
            ? "border-b border-white/10"
            : "border-b border-stone-200"
          : ""
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${
            isDark ? "bg-white/10 text-white/80" : "bg-stone-100 text-stone-700"
          }`}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <p className="font-medium truncate">{title}</p>
          {description && (
            <p
              className={`text-sm truncate ${
                isDark ? "text-white/50" : "text-stone-500"
              }`}
            >
              {description}
            </p>
          )}
        </div>
      </div>
      {control && <div className="shrink-0">{control}</div>}
    </div>
  );
}
