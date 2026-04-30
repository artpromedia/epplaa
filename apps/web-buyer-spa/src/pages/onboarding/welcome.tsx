import { useState } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles,
  Globe,
  Heart,
  Bell,
  ChevronRight,
  Check,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import {
  ONBOARDING_INTERESTS,
  useOnboarding,
} from "@/lib/onboarding-context";
import { COUNTRIES, CountryCode } from "@/lib/countries";

const STEPS = ["welcome", "country", "interests", "notifications"] as const;
type Step = (typeof STEPS)[number];

export default function OnboardingWelcome() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country, setCountry } = useCountry();
  const { markComplete } = useOnboarding();
  const [, setLocation] = useLocation();

  const [step, setStep] = useState<Step>("welcome");
  const [interests, setInterests] = useState<string[]>([]);
  const [notif, setNotif] = useState<boolean | null>(null);

  const stepIndex = STEPS.indexOf(step);

  const subtle = isDark ? "text-white/60" : "text-stone-600";

  function next() {
    const i = STEPS.indexOf(step);
    if (i < STEPS.length - 1) setStep(STEPS[i + 1]);
  }

  function finish(optIn: boolean) {
    markComplete({ interests, notificationsOptIn: optIn });
    setLocation("/");
  }

  function toggleInterest(name: string) {
    setInterests((prev) =>
      prev.includes(name) ? prev.filter((p) => p !== name) : [...prev, name],
    );
  }

  return (
    <div
      className={`absolute inset-0 z-50 flex flex-col ${
        isDark ? "bg-[#0F1525]" : "bg-[#fbeed3]"
      }`}
      data-testid="onboarding-screen"
    >
      <div className="px-4 pt-12 flex items-center gap-2">
        {STEPS.map((s, i) => (
          <span
            key={s}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i <= stepIndex
                ? isDark
                  ? "bg-[#FF8855]"
                  : "bg-[#E6502E]"
                : isDark
                  ? "bg-white/10"
                  : "bg-stone-300"
            }`}
          />
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-32 no-scrollbar">
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.18 }}
          >
            {step === "welcome" && (
              <div className="text-center pt-12">
                <div
                  className={`mx-auto w-24 h-24 rounded-3xl p-1 ${
                    isDark
                      ? "bg-gradient-to-tr from-[#FF8855] to-[#5BA3F5] shadow-[0_0_40px_rgba(255,136,85,0.4)]"
                      : "bg-gradient-to-tr from-[#E6502E] to-[#1B2A4A] shadow-lg"
                  }`}
                >
                  <div
                    className={`w-full h-full rounded-3xl flex items-center justify-center ${
                      isDark ? "bg-[#0F1525]" : "bg-[#fbeed3]"
                    }`}
                  >
                    <Sparkles
                      className={`w-10 h-10 ${
                        isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                      }`}
                    />
                  </div>
                </div>
                <h1 className="text-3xl font-black mt-6 leading-tight">
                  Welcome to Epplaa
                </h1>
                <p className={`mt-3 text-base ${subtle}`}>
                  Live shopping across 16 African markets. Watch sellers go live,
                  ask questions, and tap to buy in real time.
                </p>
                <FeatureRow
                  isDark={isDark}
                  icon={<Globe className="w-4 h-4" />}
                  label="Shop in your local currency"
                />
                <FeatureRow
                  isDark={isDark}
                  icon={<Heart className="w-4 h-4" />}
                  label="Follow hosts, save lives, build your feed"
                />
                <FeatureRow
                  isDark={isDark}
                  icon={<Sparkles className="w-4 h-4" />}
                  label="Buyer protection on every order"
                />
              </div>
            )}

            {step === "country" && (
              <div>
                <Heading title="Where are you shopping from?" subtle={subtle} />
                <div className="mt-6 grid grid-cols-2 gap-3">
                  {(Object.keys(COUNTRIES) as CountryCode[])
                    .filter((c) => COUNTRIES[c].status === "live")
                    .map((code) => {
                      const c = COUNTRIES[code];
                      const picked = country.code === code;
                      return (
                        <button
                          key={code}
                          onClick={() => setCountry(code)}
                          data-testid={`onboarding-country-${code}`}
                          className={`rounded-xl border p-3 text-left transition-all ${
                            picked
                              ? isDark
                                ? "border-[#FF8855] bg-[#FF8855]/10"
                                : "border-[#E6502E] bg-[#E6502E]/10"
                              : isDark
                                ? "border-white/10 bg-white/5"
                                : "border-stone-300 bg-white"
                          }`}
                        >
                          <span className="text-2xl leading-none">
                            {c.flag}
                          </span>
                          <p className="text-sm font-bold mt-2">{c.name}</p>
                          <p className={`text-xs ${subtle}`}>
                            {c.currency.code} ({c.currency.symbol})
                          </p>
                        </button>
                      );
                    })}
                </div>
              </div>
            )}

            {step === "interests" && (
              <div>
                <Heading
                  title="What are you into?"
                  subtle={subtle}
                  detail="Pick a few to personalize your feed. You can always change later."
                />
                <div className="mt-6 flex flex-wrap gap-2">
                  {ONBOARDING_INTERESTS.map((tag) => {
                    const picked = interests.includes(tag);
                    return (
                      <button
                        key={tag}
                        onClick={() => toggleInterest(tag)}
                        data-testid={`interest-${tag}`}
                        className={`px-4 py-2 rounded-full text-sm font-bold border transition-all ${
                          picked
                            ? isDark
                              ? "border-[#FF8855] bg-[#FF8855]/10 text-[#FF8855]"
                              : "border-[#E6502E] bg-[#E6502E]/10 text-[#E6502E]"
                            : isDark
                              ? "border-white/15 text-white/70"
                              : "border-stone-300 text-stone-700"
                        }`}
                      >
                        {picked && (
                          <Check className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />
                        )}
                        {tag}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {step === "notifications" && (
              <div>
                <Heading
                  title="Don't miss the next drop"
                  subtle={subtle}
                  detail="Get pinged when your favorite sellers go live."
                />
                <div
                  className={`mt-8 mx-auto w-20 h-20 rounded-full flex items-center justify-center ${
                    isDark
                      ? "bg-[#FF8855]/15 text-[#FF8855]"
                      : "bg-[#E6502E]/10 text-[#E6502E]"
                  }`}
                >
                  <Bell className="w-9 h-9" />
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <div
        className={`absolute bottom-0 left-0 right-0 p-4 backdrop-blur-xl border-t ${
          isDark
            ? "bg-[#0F1525]/95 border-white/10"
            : "bg-[#fbeed3]/95 border-stone-400/55"
        }`}
      >
        {step === "notifications" ? (
          <div className="space-y-2">
            <button
              onClick={() => finish(true)}
              data-testid="button-onboarding-allow"
              className={`w-full h-13 rounded-xl font-black text-base text-white ${
                isDark
                  ? "bg-gradient-to-r from-[#FF8855] to-[#FF6B35] shadow-[0_0_18px_rgba(255,136,85,0.4)]"
                  : "bg-gradient-to-r from-[#E6502E] to-[#C4441E] shadow-md"
              }`}
            >
              Turn on notifications
            </button>
            <button
              onClick={() => finish(false)}
              data-testid="button-onboarding-skip"
              className={`w-full h-12 rounded-xl font-bold text-sm ${subtle}`}
            >
              Maybe later
            </button>
          </div>
        ) : (
          <button
            onClick={next}
            disabled={step === "interests" && interests.length === 0}
            data-testid="button-onboarding-continue"
            className={`w-full h-13 rounded-xl font-black text-base flex items-center justify-center gap-2 ${
              step === "interests" && interests.length === 0
                ? "bg-stone-400 text-white cursor-not-allowed"
                : isDark
                  ? "bg-gradient-to-r from-[#FF8855] to-[#FF6B35] text-white shadow-[0_0_18px_rgba(255,136,85,0.4)]"
                  : "bg-gradient-to-r from-[#E6502E] to-[#C4441E] text-white shadow-md"
            }`}
          >
            {step === "welcome" ? "Get started" : "Continue"}
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function Heading({
  title,
  subtle,
  detail,
}: {
  title: string;
  subtle: string;
  detail?: string;
}) {
  return (
    <div className="pt-6">
      <h2 className="text-2xl font-black leading-tight">{title}</h2>
      {detail && <p className={`mt-2 text-sm ${subtle}`}>{detail}</p>}
    </div>
  );
}

function FeatureRow({
  isDark,
  icon,
  label,
}: {
  isDark: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div
      className={`mt-3 mx-auto max-w-[280px] flex items-center gap-3 rounded-xl border px-3 py-2 text-left ${
        isDark
          ? "bg-white/5 border-white/10 text-white/80"
          : "bg-white border-stone-300 text-stone-800"
      }`}
    >
      <span
        className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
          isDark ? "bg-[#FF8855]/15 text-[#FF8855]" : "bg-[#E6502E]/10 text-[#E6502E]"
        }`}
      >
        {icon}
      </span>
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}
