import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  ChevronLeft,
  Check,
  ShieldCheck,
  Store,
  Wallet,
  Users,
  Instagram,
  Music2,
  Facebook,
  Youtube,
  AtSign,
  Building2,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import {
  useSeller,
  BusinessType,
  SocialPlatform,
  SocialAccount,
} from "@/lib/seller-context";
import {
  tierFromSocialFollowers,
  TIERS,
  SOCIAL_TIER_THRESHOLDS,
} from "@/lib/seller-tiers";
import { TierBadge } from "@/components/tier-badge";
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

const STEPS = [
  "Business",
  "Social",
  "Identity",
  "Storefront",
  "Payout",
  "Review",
] as const;

const SOCIAL_PLATFORMS: {
  id: SocialPlatform;
  label: string;
  prefix: string;
  Icon: typeof Instagram;
  color: string;
}[] = [
  { id: "instagram", label: "Instagram", prefix: "@", Icon: Instagram, color: "#E1306C" },
  { id: "tiktok", label: "TikTok", prefix: "@", Icon: Music2, color: "#000000" },
  { id: "twitter", label: "X / Twitter", prefix: "@", Icon: AtSign, color: "#1DA1F2" },
  { id: "facebook", label: "Facebook", prefix: "fb.com/", Icon: Facebook, color: "#1877F2" },
  { id: "youtube", label: "YouTube", prefix: "@", Icon: Youtube, color: "#FF0000" },
];

const numberFmt = new Intl.NumberFormat("en-US");

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
  const [registryNumber, setRegistryNumber] = useState("");
  const [storeName, setStoreName] = useState("");
  const [storeHandle, setStoreHandle] = useState("");
  const [storeBio, setStoreBio] = useState("");
  const [primaryCategory, setPrimaryCategory] = useState(CATEGORIES[0]);

  const [idTypeCode, setIdTypeCode] = useState(country.identityDocs[0].code);
  const [idValue, setIdValue] = useState("");
  const [govIdLabel, setGovIdLabel] = useState("");
  const [payoutBank, setPayoutBank] = useState("");
  const [payoutAccount, setPayoutAccount] = useState("");
  const [accepted, setAccepted] = useState(false);

  // Social handles + follower counts (one row per platform).
  const [socials, setSocials] = useState<Record<SocialPlatform, { handle: string; followers: string }>>({
    instagram: { handle: "", followers: "" },
    tiktok: { handle: "", followers: "" },
    twitter: { handle: "", followers: "" },
    facebook: { handle: "", followers: "" },
    youtube: { handle: "", followers: "" },
  });

  const idDoc = useMemo(
    () =>
      country.identityDocs.find((d) => d.code === idTypeCode) ??
      country.identityDocs[0],
    [country, idTypeCode],
  );

  // Only count followers from rows that actually have a handle — prevents
  // gaming the tier gate by typing big numbers without linking an account.
  const totalFollowers = useMemo(
    () =>
      Object.values(socials).reduce((sum, s) => {
        if (!s.handle.trim()) return sum;
        return sum + (parseInt(s.followers.replace(/\D/g, ""), 10) || 0);
      }, 0),
    [socials],
  );

  const projectedTier = tierFromSocialFollowers(totalFollowers);

  const cardClass = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";
  const subtleText = isDark ? "text-white/50" : "text-stone-500";
  const inputClass = `w-full px-3 py-2 rounded-lg border text-sm outline-none focus:ring-2 focus:ring-[#5BA3F5]/30 ${
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
                isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
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
              isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
            }`}
            data-testid="button-go-studio"
          >
            Open Seller Studio
          </button>
        </div>
      </div>
    );
  }

  function validateIdValue(): boolean {
    const stripped =
      idDoc.kind === "digits"
        ? idValue.replace(/\D/g, "")
        : idValue.replace(/[^A-Za-z0-9]/g, "");
    return stripped.length === idDoc.expectedLength;
  }

  function validateAccount(): boolean {
    const digits = payoutAccount.replace(/\D/g, "").length;
    return (
      digits >= country.bankAccount.minDigits &&
      digits <= country.bankAccount.maxDigits
    );
  }

  function nextStep() {
    if (step === 0) {
      if (!legalName.trim()) {
        toast({ title: "Add your legal name to continue" });
        return;
      }
      if (businessType === "registered" && !registryNumber.trim()) {
        toast({
          title: `Add your ${country.businessRegistry.numberLabel}`,
        });
        return;
      }
    }
    if (step === 1) {
      const hasAtLeastOne = Object.values(socials).some(
        (s) => s.handle.trim().length > 0,
      );
      if (!hasAtLeastOne) {
        toast({
          title: "Link at least one social account",
          description:
            "We use your existing audience to set your starting tier.",
        });
        return;
      }
    }
    if (step === 2) {
      if (!validateIdValue()) {
        toast({
          title: `${idDoc.label} must be ${idDoc.expectedLength} ${idDoc.kind === "digits" ? "digits" : "characters"}`,
        });
        return;
      }
      if (!govIdLabel.trim()) {
        toast({ title: "Upload a government ID image to continue" });
        return;
      }
    }
    if (step === 3) {
      if (
        !storeName.trim() ||
        !storeHandle.trim() ||
        storeHandle.length < 3
      ) {
        toast({
          title: "Pick a store name and a handle of 3+ characters",
        });
        return;
      }
    }
    if (step === 4) {
      if (!payoutBank.trim() || !validateAccount()) {
        const min = country.bankAccount.minDigits;
        const max = country.bankAccount.maxDigits;
        const range = min === max ? `${min}` : `${min}-${max}`;
        toast({
          title: `Add your bank and a valid ${range}-digit account number`,
        });
        return;
      }
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }

  function prevStep() {
    setStep((s) => Math.max(0, s - 1));
  }

  function buildSocialAccountsList(): SocialAccount[] {
    return SOCIAL_PLATFORMS.map((p) => {
      const row = socials[p.id];
      const handle = row.handle.trim();
      const followers = parseInt(row.followers.replace(/\D/g, ""), 10) || 0;
      if (!handle) return null;
      return { platform: p.id, handle, followers };
    }).filter((x): x is SocialAccount => x !== null);
  }

  function submit() {
    if (!accepted) {
      toast({ title: "Accept the seller terms to submit" });
      return;
    }
    const socialList = buildSocialAccountsList();
    // Derive persisted totalFollowers from the filtered list so the stored
    // value always matches the linked accounts that back it up.
    const verifiedTotalFollowers = socialList.reduce(
      (sum, a) => sum + a.followers,
      0,
    );
    submitApplication({
      businessType,
      legalName: legalName.trim(),
      storeName: storeName.trim(),
      storeHandle: storeHandle.trim().toLowerCase(),
      storeBio: storeBio.trim(),
      primaryCategory,
      countryCode: country.code,
      identification: {
        typeCode: idDoc.code,
        typeLabel: idDoc.label,
        last4: idValue.replace(/[^A-Za-z0-9]/g, "").slice(-4),
      },
      govIdLabel: govIdLabel.trim(),
      payoutBank: payoutBank.trim(),
      payoutAccountLast4: payoutAccount.replace(/\D/g, "").slice(-4),
      registryNumber:
        businessType === "registered" ? registryNumber.trim() : undefined,
      registryShortName:
        businessType === "registered"
          ? country.businessRegistry.shortName
          : undefined,
      socialAccounts: socialList,
      totalFollowers: verifiedTotalFollowers,
    });
    toast({
      title: "Application approved",
      description: `Welcome to Epplaa Sellers — ${TIERS[projectedTier].label} tier unlocked.`,
    });
    navigate("/seller/studio");
  }

  function updateSocial(
    id: SocialPlatform,
    patch: Partial<{ handle: string; followers: string }>,
  ) {
    setSocials((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
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
                      desc: "Just me selling — no business registration.",
                    },
                    {
                      v: "registered",
                      title: "Registered Business",
                      desc: `I have a ${country.businessRegistry.shortName} registration.`,
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
                          ? "bg-[#5BA3F5]/10 border-[#5BA3F5]/30"
                          : "bg-[#1B2A4A]/10 border-[#1B2A4A]/30"
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
                <div className="flex items-center gap-2 mb-1">
                  <Building2
                    className={`w-4 h-4 ${
                      isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                    }`}
                  />
                  <label className="block text-sm font-bold">
                    {country.businessRegistry.numberLabel}
                  </label>
                </div>
                <input
                  value={registryNumber}
                  onChange={(e) => setRegistryNumber(e.target.value)}
                  placeholder={country.businessRegistry.numberPlaceholder}
                  className={inputClass}
                  data-testid="input-registry-number"
                />
                <p className={`text-xs mt-1 ${subtleText}`}>
                  {country.businessRegistry.numberHelper} ·{" "}
                  {country.businessRegistry.fullName}
                </p>
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <div className={`rounded-xl border p-4 space-y-4 ${cardClass}`}>
            <div className="flex items-center gap-2">
              <Users
                className={`w-5 h-5 ${
                  isDark ? "text-[#ff0080]" : "text-[#cc0066]"
                }`}
              />
              <h2 className="font-bold">Your social presence</h2>
            </div>
            <p className={`text-sm ${subtleText}`}>
              Sellers are onboarded based on the audience they bring from other
              platforms. Add the accounts you actively use — your combined
              follower count sets your starting tier.
            </p>

            <div className="space-y-3">
              {SOCIAL_PLATFORMS.map((p) => {
                const row = socials[p.id];
                return (
                  <div
                    key={p.id}
                    className={`rounded-lg border p-3 space-y-2 ${
                      isDark
                        ? "bg-black/40 border-white/10"
                        : "bg-white border-stone-300"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className="w-7 h-7 rounded-full flex items-center justify-center"
                        style={{
                          backgroundColor: `${p.color}1f`,
                          color: p.color,
                        }}
                      >
                        <p.Icon className="w-4 h-4" />
                      </div>
                      <span className="font-bold text-sm">{p.label}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="relative">
                        <span
                          className={`absolute left-3 top-1/2 -translate-y-1/2 text-xs ${subtleText}`}
                        >
                          {p.prefix}
                        </span>
                        <input
                          value={row.handle}
                          onChange={(e) =>
                            updateSocial(p.id, { handle: e.target.value })
                          }
                          placeholder="handle"
                          className={`${inputClass} ${
                            p.prefix === "@" ? "pl-7" : "pl-14"
                          }`}
                          data-testid={`input-social-${p.id}-handle`}
                        />
                      </div>
                      <input
                        value={row.followers}
                        onChange={(e) =>
                          updateSocial(p.id, {
                            followers: e.target.value
                              .replace(/[^\d,]/g, "")
                              .replace(/,/g, ""),
                          })
                        }
                        placeholder="followers"
                        inputMode="numeric"
                        className={inputClass}
                        data-testid={`input-social-${p.id}-followers`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div
              className={`rounded-lg p-3 border-2 border-dashed ${
                isDark
                  ? "border-[#5BA3F5]/30 bg-[#5BA3F5]/5"
                  : "border-[#1B2A4A]/30 bg-[#1B2A4A]/5"
              }`}
              data-testid="tier-preview"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className={`text-xs uppercase tracking-wider font-bold ${subtleText}`}>
                    Starting tier
                  </p>
                  <p className="font-bold text-lg flex items-center gap-2">
                    {TIERS[projectedTier].label}
                    <TierBadge tier={projectedTier} size="md" />
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className={`text-xs ${subtleText}`}>Total followers</p>
                  <p className="font-bold text-lg" data-testid="text-total-followers">
                    {numberFmt.format(totalFollowers)}
                  </p>
                </div>
              </div>
              <div className={`text-xs mt-2 ${subtleText} space-y-0.5`}>
                <p>
                  {numberFmt.format(SOCIAL_TIER_THRESHOLDS.pro)}+ followers →
                  start at <strong>Pro</strong>
                </p>
                <p>
                  {numberFmt.format(SOCIAL_TIER_THRESHOLDS.elite)}+ followers →
                  start at <strong>Elite</strong>
                </p>
                <p className="pt-1 italic">
                  We verify follower counts within 24h before payouts unlock.
                </p>
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className={`rounded-xl border p-4 space-y-4 ${cardClass}`}>
            <div className="flex items-center gap-2">
              <ShieldCheck
                className={`w-5 h-5 ${
                  isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                }`}
              />
              <h2 className="font-bold">Identity verification</h2>
            </div>
            <p className={`text-sm ${subtleText}`}>
              Required by the {country.payoutAuthority} for any seller
              receiving payouts in {country.name}.
            </p>
            <div>
              <label className="block text-sm font-bold mb-1">ID type</label>
              <div className="flex gap-2 flex-wrap">
                {country.identityDocs.map((d) => (
                  <button
                    key={d.code}
                    onClick={() => {
                      setIdTypeCode(d.code);
                      setIdValue("");
                    }}
                    className={`flex-1 min-w-[120px] py-2 px-3 rounded-lg border font-medium text-sm ${
                      idTypeCode === d.code
                        ? isDark
                          ? "bg-[#5BA3F5]/10 border-[#5BA3F5]/30 text-[#5BA3F5]"
                          : "bg-[#1B2A4A]/10 border-[#1B2A4A]/30 text-[#1B2A4A]"
                        : isDark
                          ? "bg-black/40 border-white/10"
                          : "bg-white border-stone-300"
                    }`}
                    data-testid={`id-type-${d.code.toLowerCase()}`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">
                {idDoc.label} number
              </label>
              <input
                value={idValue}
                onChange={(e) => setIdValue(e.target.value)}
                placeholder={
                  idDoc.kind === "digits"
                    ? `${idDoc.expectedLength} digits`
                    : `${idDoc.expectedLength} characters`
                }
                className={inputClass}
                data-testid="input-id-value"
              />
              <p className={`text-xs mt-1 ${subtleText}`}>
                {idDoc.helper} · We only store the last 4 characters on this
                device.
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

        {step === 3 && (
          <div className={`rounded-xl border p-4 space-y-4 ${cardClass}`}>
            <div className="flex items-center gap-2">
              <Store
                className={`w-5 h-5 ${
                  isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                }`}
              />
              <h2 className="font-bold">Set up your storefront</h2>
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">Store name</label>
              <input
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                placeholder={`Ada Beauty ${country.primaryCity}`}
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
                  placeholder="ada_beauty"
                  className={inputClass}
                  data-testid="input-store-handle"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">Short bio</label>
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

        {step === 4 && (
          <div className={`rounded-xl border p-4 space-y-4 ${cardClass}`}>
            <div className="flex items-center gap-2">
              <Wallet
                className={`w-5 h-5 ${
                  isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                }`}
              />
              <h2 className="font-bold">Where should we send payouts?</h2>
            </div>
            <p className={`text-sm ${subtleText}`}>
              Payouts go to a bank account in your name only.{" "}
              {TIERS[projectedTier].label} tier ={" "}
              {TIERS[projectedTier].payoutFrequency.toLowerCase()} payouts.
            </p>
            <div>
              <label className="block text-sm font-bold mb-1">Bank</label>
              <input
                value={payoutBank}
                onChange={(e) => setPayoutBank(e.target.value)}
                placeholder={bankPlaceholderForCountry(country.code)}
                className={inputClass}
                data-testid="input-payout-bank"
              />
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">
                {country.bankAccount.label}
              </label>
              <input
                value={payoutAccount}
                onChange={(e) => setPayoutAccount(e.target.value)}
                placeholder={country.bankAccount.placeholder}
                className={inputClass}
                data-testid="input-payout-account"
              />
              <p className={`text-xs mt-1 ${subtleText}`}>
                We only store the last 4 digits on this device.
              </p>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className={`rounded-xl border p-4 space-y-4 ${cardClass}`}>
            <h2 className="font-bold">Review &amp; submit</h2>
            <div className={`text-sm space-y-2 ${subtleText}`}>
              <Row k="Business type" v={titleCase(businessType)} />
              <Row k="Legal name" v={legalName} />
              {businessType === "registered" && (
                <Row
                  k={country.businessRegistry.shortName}
                  v={registryNumber}
                />
              )}
              <Row
                k="ID"
                v={`${idDoc.label} •••• ${idValue.replace(/[^A-Za-z0-9]/g, "").slice(-4)}`}
              />
              <Row k="Store" v={`${storeName} (@${storeHandle})`} />
              <Row k="Category" v={primaryCategory} />
              <Row
                k="Payout"
                v={`${payoutBank} •••• ${payoutAccount.replace(/\D/g, "").slice(-4)}`}
              />
              <Row k="Country" v={`${country.flag} ${country.name}`} />
              <Row
                k="Total followers"
                v={numberFmt.format(totalFollowers)}
              />
            </div>

            <div
              className={`rounded-lg p-3 flex items-center justify-between gap-3 ${
                isDark ? "bg-[#5BA3F5]/10" : "bg-[#1B2A4A]/10"
              }`}
            >
              <div>
                <p className={`text-xs uppercase tracking-wider font-bold ${subtleText}`}>
                  Starting tier
                </p>
                <p className="font-bold text-lg">{TIERS[projectedTier].label}</p>
              </div>
              <TierBadge tier={projectedTier} size="md" />
            </div>

            <label className="flex items-start gap-3 pt-2">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
                className="mt-1 w-4 h-4 accent-[#1B2A4A]"
                data-testid="checkbox-accept"
              />
              <span className={`text-sm ${subtleText}`}>
                I agree to the Epplaa Seller Terms, prohibited-items policy,
                and Buyer Protection program. I confirm all information is
                accurate and that follower counts can be verified.
              </span>
            </label>
            <p
              className={`text-xs ${subtleText} border-t pt-3 ${
                isDark ? "border-white/10" : "border-stone-200"
              }`}
            >
              In production, applications take 24-48 hours to review while we
              verify your social audience. For this preview, you'll be approved
              instantly to <strong>{TIERS[projectedTier].label}</strong> tier.
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
                isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
              }`}
              data-testid="button-next-step"
            >
              Continue
            </button>
          ) : (
            <button
              onClick={submit}
              className={`flex-1 py-3 rounded-full font-bold ${
                isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
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

function bankPlaceholderForCountry(code: string): string {
  switch (code) {
    case "NG":
      return "GTBank, Access, Kuda...";
    case "GH":
      return "GCB, Ecobank, Stanbic...";
    case "KE":
      return "KCB, Equity, NCBA...";
    case "ZA":
      return "FNB, Standard Bank, Capitec...";
    case "CI":
      return "Ecobank, SGBCI, Société Générale...";
    default:
      return "Your bank";
  }
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
        isDark ? "bg-[#0F1525]" : "bg-[#fbeed3]"
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
                    ? "bg-[#5BA3F5]"
                    : "bg-[#1B2A4A]"
                  : isDark
                    ? "bg-white/10"
                    : "bg-stone-300"
              }`}
            />
            <p
              className={`text-[9px] mt-1 font-bold uppercase tracking-wider text-center ${
                active
                  ? isDark
                    ? "text-[#5BA3F5]"
                    : "text-[#1B2A4A]"
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
