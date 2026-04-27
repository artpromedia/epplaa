import { useState } from "react";
import { useLocation } from "wouter";
import { ChevronLeft, Check, ShieldCheck, Store, Wallet } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useSeller, BusinessType } from "@/lib/seller-context";
import { useToast } from "@/hooks/use-toast";

const CATEGORIES = [
  "Beauty",
  "Fashion",
  "Phones & Tech",
  "Home & Living",
  "Food & Drinks",
  "Kids",
  "Other",
];

const STEPS = ["Business", "Identity", "Storefront", "Payout", "Review"] as const;

export default function SellerApply() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { submitApplication, status } = useSeller();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const [step, setStep] = useState(0);

  const [businessType, setBusinessType] = useState<BusinessType>("individual");
  const [legalName, setLegalName] = useState("");
  const [storeName, setStoreName] = useState("");
  const [storeHandle, setStoreHandle] = useState("");
  const [storeBio, setStoreBio] = useState("");
  const [primaryCategory, setPrimaryCategory] = useState(CATEGORIES[0]);
  const [idType, setIdType] = useState<"BVN" | "NIN">("BVN");
  const [idValue, setIdValue] = useState("");
  const [govIdLabel, setGovIdLabel] = useState("");
  const [payoutBank, setPayoutBank] = useState("");
  const [payoutAccount, setPayoutAccount] = useState("");
  const [cacNumber, setCacNumber] = useState("");
  const [accepted, setAccepted] = useState(false);

  const cardClass = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";
  const subtleText = isDark ? "text-white/50" : "text-stone-500";
  const inputClass = `w-full px-3 py-2 rounded-lg border text-sm outline-none focus:ring-2 focus:ring-[#00ffff]/30 ${
    isDark
      ? "bg-black/40 border-white/10 text-white placeholder:text-white/30"
      : "bg-white border-stone-300 text-stone-900 placeholder:text-stone-400"
  }`;

  if (status === "approved") {
    return (
      <div className="flex flex-col h-full w-full">
        <Header isDark={isDark} title="Already a seller" />
        <div className="px-4 py-6 space-y-4">
          <div className={`rounded-xl border p-6 text-center ${cardClass}`}>
            <Check
              className={`w-10 h-10 mx-auto mb-3 ${
                isDark ? "text-[#00ffff]" : "text-[#00b3b3]"
              }`}
            />
            <p className="font-bold mb-1">You're vetted</p>
            <p className={`text-sm ${subtleText}`}>
              Head to your seller studio to manage listings, payouts, and live
              broadcasts.
            </p>
          </div>
          <button
            onClick={() => navigate("/seller/studio")}
            className={`w-full py-3 rounded-full font-bold ${
              isDark ? "bg-[#00ffff] text-black" : "bg-[#00b3b3] text-white"
            }`}
            data-testid="button-go-studio"
          >
            Open Seller Studio
          </button>
        </div>
      </div>
    );
  }

  function nextStep() {
    if (step === 0 && !legalName.trim()) {
      toast({ title: "Add your legal name to continue" });
      return;
    }
    if (step === 1 && idValue.replace(/\D/g, "").length !== 11) {
      toast({ title: `${idType} must be 11 digits` });
      return;
    }
    if (step === 1 && !govIdLabel.trim()) {
      toast({ title: "Upload a government ID image to continue" });
      return;
    }
    if (
      step === 2 &&
      (!storeName.trim() || !storeHandle.trim() || storeHandle.length < 3)
    ) {
      toast({ title: "Pick a store name and a handle of 3+ characters" });
      return;
    }
    if (
      step === 3 &&
      (!payoutBank.trim() || payoutAccount.replace(/\D/g, "").length !== 10)
    ) {
      toast({ title: "Add your bank and a valid 10-digit account number" });
      return;
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }

  function prevStep() {
    setStep((s) => Math.max(0, s - 1));
  }

  function submit() {
    if (!accepted) {
      toast({ title: "Accept the seller terms to submit" });
      return;
    }
    submitApplication({
      businessType,
      legalName: legalName.trim(),
      storeName: storeName.trim(),
      storeHandle: storeHandle.trim().toLowerCase(),
      storeBio: storeBio.trim(),
      primaryCategory,
      countryCode: country.code,
      identification: { type: idType, last4: idValue.replace(/\D/g, "").slice(-4) },
      govIdLabel: govIdLabel.trim(),
      payoutBank: payoutBank.trim(),
      payoutAccountLast4: payoutAccount.replace(/\D/g, "").slice(-4),
      cacNumber: businessType === "registered" ? cacNumber.trim() : undefined,
    });
    toast({
      title: "Application approved",
      description: "Welcome to Epplaa Sellers — Starter tier unlocked.",
    });
    navigate("/seller/studio");
  }

  return (
    <div className="flex flex-col h-full w-full">
      <Header isDark={isDark} title="Become a Seller" />

      <div className="px-4 pb-24 space-y-6">
        <Stepper step={step} isDark={isDark} />

        {step === 0 && (
          <div className={`rounded-xl border p-4 space-y-4 ${cardClass}`}>
            <h2 className="font-bold">Tell us about your business</h2>
            <div className="space-y-2">
              <label className="block text-sm font-bold">
                What kind of seller are you?
              </label>
              <div className="grid grid-cols-1 gap-2">
                {(
                  [
                    {
                      v: "individual",
                      title: "Individual",
                      desc: "Just me selling — Starter tier.",
                    },
                    {
                      v: "registered",
                      title: "Registered Business",
                      desc: "I have a CAC reg — Pro track.",
                    },
                    {
                      v: "brand",
                      title: "Established Brand",
                      desc: "Trademarked brand — Elite track.",
                    },
                  ] as { v: BusinessType; title: string; desc: string }[]
                ).map((opt) => (
                  <button
                    key={opt.v}
                    onClick={() => setBusinessType(opt.v)}
                    className={`text-left p-3 rounded-lg border transition-colors ${
                      businessType === opt.v
                        ? isDark
                          ? "bg-[#00ffff]/10 border-[#00ffff]/30"
                          : "bg-[#00b3b3]/10 border-[#00b3b3]/30"
                        : isDark
                          ? "bg-black/40 border-white/10 hover:bg-white/5"
                          : "bg-white border-stone-300 hover:bg-stone-50"
                    }`}
                    data-testid={`business-type-${opt.v}`}
                  >
                    <p className="font-bold">{opt.title}</p>
                    <p className={`text-sm ${subtleText}`}>{opt.desc}</p>
                  </button>
                ))}
              </div>
              <p className={`text-xs ${subtleText} pt-1`}>
                Everyone starts at <strong>Starter</strong>. You'll qualify to
                upgrade to Pro or Elite as you grow.
              </p>
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">Legal name</label>
              <input
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                placeholder="As it appears on your ID"
                className={inputClass}
                data-testid="input-legal-name"
              />
            </div>
            {businessType === "registered" && (
              <div>
                <label className="block text-sm font-bold mb-1">
                  CAC registration number (optional now)
                </label>
                <input
                  value={cacNumber}
                  onChange={(e) => setCacNumber(e.target.value)}
                  placeholder="RC-1234567"
                  className={inputClass}
                  data-testid="input-cac"
                />
                <p className={`text-xs mt-1 ${subtleText}`}>
                  You can add this later when upgrading to Pro.
                </p>
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <div className={`rounded-xl border p-4 space-y-4 ${cardClass}`}>
            <div className="flex items-center gap-2">
              <ShieldCheck
                className={`w-5 h-5 ${
                  isDark ? "text-[#00ffff]" : "text-[#00b3b3]"
                }`}
              />
              <h2 className="font-bold">Identity verification</h2>
            </div>
            <p className={`text-sm ${subtleText}`}>
              Required by the Central Bank of Nigeria for any seller receiving
              payouts.
            </p>
            <div>
              <label className="block text-sm font-bold mb-1">ID type</label>
              <div className="flex gap-2">
                {(["BVN", "NIN"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setIdType(t)}
                    className={`flex-1 py-2 rounded-lg border font-medium ${
                      idType === t
                        ? isDark
                          ? "bg-[#00ffff]/10 border-[#00ffff]/30 text-[#00ffff]"
                          : "bg-[#00b3b3]/10 border-[#00b3b3]/30 text-[#00b3b3]"
                        : isDark
                          ? "bg-black/40 border-white/10"
                          : "bg-white border-stone-300"
                    }`}
                    data-testid={`id-type-${t.toLowerCase()}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">
                {idType} number
              </label>
              <input
                value={idValue}
                onChange={(e) => setIdValue(e.target.value)}
                placeholder="11 digits"
                className={inputClass}
                data-testid="input-id-value"
              />
              <p className={`text-xs mt-1 ${subtleText}`}>
                We only store the last 4 digits on this device.
              </p>
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">
                Government ID upload
              </label>
              <label
                className={`flex items-center justify-center gap-2 py-3 rounded-lg border-2 border-dashed cursor-pointer ${
                  isDark
                    ? "border-white/20 text-white/70 hover:bg-white/5"
                    : "border-stone-400 text-stone-600 hover:bg-stone-50"
                }`}
                data-testid="upload-gov-id"
              >
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setGovIdLabel(f.name);
                  }}
                />
                {govIdLabel ? (
                  <span className="text-sm font-medium truncate max-w-[240px]">
                    ✓ {govIdLabel}
                  </span>
                ) : (
                  <span className="text-sm">Tap to upload ID image / PDF</span>
                )}
              </label>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className={`rounded-xl border p-4 space-y-4 ${cardClass}`}>
            <div className="flex items-center gap-2">
              <Store
                className={`w-5 h-5 ${
                  isDark ? "text-[#00ffff]" : "text-[#00b3b3]"
                }`}
              />
              <h2 className="font-bold">Set up your storefront</h2>
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">
                Store name
              </label>
              <input
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                placeholder="Ada Beauty Lagos"
                className={inputClass}
                data-testid="input-store-name"
              />
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">Handle</label>
              <div className="flex items-center gap-2">
                <span className={subtleText}>@</span>
                <input
                  value={storeHandle}
                  onChange={(e) =>
                    setStoreHandle(
                      e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""),
                    )
                  }
                  placeholder="ada_beauty_lagos"
                  className={inputClass}
                  data-testid="input-store-handle"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">
                Short bio
              </label>
              <textarea
                value={storeBio}
                onChange={(e) => setStoreBio(e.target.value.slice(0, 160))}
                placeholder="What do you sell? Who do you serve?"
                rows={3}
                className={inputClass}
                data-testid="input-store-bio"
              />
              <p className={`text-xs mt-1 ${subtleText}`}>
                {storeBio.length}/160
              </p>
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">
                Primary category
              </label>
              <select
                value={primaryCategory}
                onChange={(e) => setPrimaryCategory(e.target.value)}
                className={inputClass}
                data-testid="select-category"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className={`rounded-xl border p-4 space-y-4 ${cardClass}`}>
            <div className="flex items-center gap-2">
              <Wallet
                className={`w-5 h-5 ${
                  isDark ? "text-[#00ffff]" : "text-[#00b3b3]"
                }`}
              />
              <h2 className="font-bold">Where should we send payouts?</h2>
            </div>
            <p className={`text-sm ${subtleText}`}>
              Payouts go to a bank account in your name only. Starter tier =
              weekly payouts.
            </p>
            <div>
              <label className="block text-sm font-bold mb-1">Bank</label>
              <input
                value={payoutBank}
                onChange={(e) => setPayoutBank(e.target.value)}
                placeholder="GTBank, Access, Kuda..."
                className={inputClass}
                data-testid="input-payout-bank"
              />
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">
                Account number
              </label>
              <input
                value={payoutAccount}
                onChange={(e) => setPayoutAccount(e.target.value)}
                placeholder="10 digit NUBAN"
                className={inputClass}
                data-testid="input-payout-account"
              />
              <p className={`text-xs mt-1 ${subtleText}`}>
                We only store the last 4 digits on this device.
              </p>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className={`rounded-xl border p-4 space-y-4 ${cardClass}`}>
            <h2 className="font-bold">Review &amp; submit</h2>
            <div className={`text-sm space-y-2 ${subtleText}`}>
              <Row k="Business type" v={titleCase(businessType)} />
              <Row k="Legal name" v={legalName} />
              <Row k="ID" v={`${idType} •••• ${idValue.replace(/\D/g, "").slice(-4)}`} />
              <Row k="Store" v={`${storeName} (@${storeHandle})`} />
              <Row k="Category" v={primaryCategory} />
              <Row
                k="Payout"
                v={`${payoutBank} •••• ${payoutAccount.replace(/\D/g, "").slice(-4)}`}
              />
              <Row k="Country" v={`${country.flag} ${country.name}`} />
            </div>
            <label className="flex items-start gap-3 pt-2">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
                className="mt-1 w-4 h-4 accent-[#00b3b3]"
                data-testid="checkbox-accept"
              />
              <span className={`text-sm ${subtleText}`}>
                I agree to the Epplaa Seller Terms, prohibited-items policy, and
                Buyer Protection program. I confirm all information is accurate.
              </span>
            </label>
            <p
              className={`text-xs ${subtleText} border-t pt-3 ${
                isDark ? "border-white/10" : "border-stone-200"
              }`}
            >
              In production, applications take 24-48 hours to review. For this
              preview, you'll be approved instantly to <strong>Starter</strong>{" "}
              tier.
            </p>
          </div>
        )}

        <div className="flex gap-2 pt-2">
          {step > 0 && (
            <button
              onClick={prevStep}
              className={`flex-1 py-3 rounded-full font-medium ${
                isDark
                  ? "bg-white/10 hover:bg-white/15"
                  : "bg-stone-200 hover:bg-stone-300"
              }`}
              data-testid="button-back-step"
            >
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button
              onClick={nextStep}
              className={`flex-1 py-3 rounded-full font-bold ${
                isDark ? "bg-[#00ffff] text-black" : "bg-[#00b3b3] text-white"
              }`}
              data-testid="button-next-step"
            >
              Continue
            </button>
          ) : (
            <button
              onClick={submit}
              className={`flex-1 py-3 rounded-full font-bold ${
                isDark ? "bg-[#00ffff] text-black" : "bg-[#00b3b3] text-white"
              }`}
              data-testid="button-submit-application"
            >
              Submit application
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span>{k}</span>
      <span className="text-right truncate max-w-[55%] font-medium">{v}</span>
    </div>
  );
}

function Header({ isDark, title }: { isDark: boolean; title: string }) {
  const [, navigate] = useLocation();
  return (
    <div
      className={`pt-12 pb-4 px-4 z-10 sticky top-0 ${
        isDark ? "bg-[#050505]" : "bg-[#fbeed3]"
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          onClick={() => navigate("/profile")}
          className={`flex items-center justify-center w-9 h-9 -ml-2 rounded-full ${
            isDark ? "hover:bg-white/10" : "hover:bg-stone-200"
          }`}
          aria-label="Back"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h1 className="text-xl font-bold truncate">{title}</h1>
      </div>
    </div>
  );
}

function Stepper({ step, isDark }: { step: number; isDark: boolean }) {
  return (
    <div className="flex items-center gap-1">
      {STEPS.map((label, i) => {
        const active = i <= step;
        return (
          <div key={label} className="flex-1">
            <div
              className={`h-1 rounded-full transition-colors ${
                active
                  ? isDark
                    ? "bg-[#00ffff]"
                    : "bg-[#00b3b3]"
                  : isDark
                    ? "bg-white/10"
                    : "bg-stone-300"
              }`}
            />
            <p
              className={`text-[10px] mt-1 font-bold uppercase tracking-wider text-center ${
                active
                  ? isDark
                    ? "text-[#00ffff]"
                    : "text-[#00b3b3]"
                  : isDark
                    ? "text-white/30"
                    : "text-stone-400"
              }`}
            >
              {label}
            </p>
          </div>
        );
      })}
    </div>
  );
}
