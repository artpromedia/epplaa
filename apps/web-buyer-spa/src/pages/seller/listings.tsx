import { useState } from "react";
import { Link } from "wouter";
import {
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Package,
  AlertCircle,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useSeller } from "@/lib/seller-context";
import { TIERS } from "@/lib/seller-tiers";
import { formatPrice } from "@/lib/format";
import { ThemeToggle } from "@/components/theme-toggle";
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

export default function SellerListings() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const {
    status,
    tier,
    listings,
    addListing,
    updateListing,
    removeListing,
  } = useSeller();
  const { toast } = useToast();

  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [priceMajor, setPriceMajor] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [inventory, setInventory] = useState("1");

  if (status !== "approved") {
    return <NotApprovedState isDark={isDark} />;
  }

  const cardClass = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";
  const subtleText = isDark ? "text-white/50" : "text-stone-500";
  const inputClass = `w-full px-3 py-2 rounded-lg border text-sm outline-none focus:ring-2 focus:ring-[#5BA3F5]/30 ${
    isDark
      ? "bg-black/40 border-white/10 text-white placeholder:text-white/30"
      : "bg-white border-stone-300 text-stone-900 placeholder:text-stone-400"
  }`;

  const def = TIERS[tier];
  const activeCount = listings.filter((l) => l.status === "active").length;
  const atCap =
    def.maxListings !== null && activeCount >= def.maxListings;

  function reset() {
    setShowForm(false);
    setTitle("");
    setPriceMajor("");
    setCategory(CATEGORIES[0]);
    setInventory("1");
  }

  function save() {
    if (!title.trim()) {
      toast({ title: "Add a product title" });
      return;
    }
    const priceNum = Number(priceMajor.replace(/,/g, ""));
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      toast({ title: "Enter a valid price" });
      return;
    }
    const inv = Math.max(0, Number(inventory) || 0);
    void (async () => {
      const next = await addListing({
        title: title.trim(),
        priceMinor: Math.round(priceNum * country.currency.minorPerMajor),
        countryCode: country.code,
        category,
        inventory: inv,
      });
      toast({
        title: next.status === "draft" ? "Saved as draft" : "Listing live",
        description:
          next.status === "draft"
            ? `You're at your ${def.label} tier listing cap. Upgrade for more.`
            : "It's now visible in your storefront.",
      });
      reset();
    })();
  }

  return (
    <div className="flex flex-col h-full w-full">
      <div
        className={`pt-12 pb-4 px-4 z-10 sticky top-0 ${
          isDark ? "bg-[#0F1525]" : "bg-[#fbeed3]"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold">Listings</h1>
              <TierBadge tier={tier} />
            </div>
            <p className={`text-xs ${subtleText}`}>
              {activeCount} active
              {def.maxListings ? ` of ${def.maxListings}` : " (unlimited)"} ·{" "}
              {country.flag} {country.name}
            </p>
          </div>
          <ThemeToggle />
        </div>
      </div>

      <div className="px-4 pb-24 space-y-4">
        {atCap && !showForm && (
          <div
            className={`rounded-xl border p-3 flex gap-2 items-start ${
              isDark
                ? "bg-amber-500/5 border-amber-500/30"
                : "bg-amber-50 border-amber-300"
            }`}
          >
            <AlertCircle
              className={`w-4 h-4 mt-0.5 ${
                isDark ? "text-amber-300" : "text-amber-600"
              }`}
            />
            <div className="text-sm">
              <p className="font-bold">You're at your listing cap</p>
              <p className={subtleText}>
                New listings will be saved as drafts. Upgrade your tier to
                publish more.
              </p>
            </div>
          </div>
        )}

        {!showForm ? (
          <button
            onClick={() => setShowForm(true)}
            className={`w-full flex items-center justify-center gap-2 py-3 rounded-full font-bold ${
              isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
            }`}
            data-testid="button-add-listing"
          >
            <Plus className="w-5 h-5" />
            Add a listing
          </button>
        ) : (
          <div className={`rounded-xl border p-4 space-y-3 ${cardClass}`}>
            <h2 className="font-bold">New listing</h2>
            <div>
              <label className="block text-sm font-bold mb-1">Title</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Vivid Glow Highlighter Set"
                className={inputClass}
                data-testid="input-listing-title"
              />
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">
                Price ({country.currency.code})
              </label>
              <div className="flex items-center gap-2">
                <span className={subtleText}>{country.currency.symbol}</span>
                <input
                  inputMode="decimal"
                  value={priceMajor}
                  onChange={(e) => setPriceMajor(e.target.value)}
                  placeholder="12000"
                  className={inputClass}
                  data-testid="input-listing-price"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className={inputClass}
                data-testid="select-listing-category"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">Inventory</label>
              <input
                inputMode="numeric"
                value={inventory}
                onChange={(e) => setInventory(e.target.value)}
                placeholder="1"
                className={inputClass}
                data-testid="input-listing-inventory"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={reset}
                className={`flex-1 py-2 rounded-full font-medium ${
                  isDark
                    ? "bg-white/10 hover:bg-white/15"
                    : "bg-stone-200 hover:bg-stone-300"
                }`}
                data-testid="button-cancel-listing"
              >
                Cancel
              </button>
              <button
                onClick={save}
                className={`flex-1 py-2 rounded-full font-bold ${
                  isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
                }`}
                data-testid="button-save-listing"
              >
                Save
              </button>
            </div>
          </div>
        )}

        {listings.length === 0 && !showForm && (
          <div className={`rounded-xl border p-6 text-center ${cardClass}`}>
            <Package className={`w-8 h-8 mx-auto mb-2 ${subtleText}`} />
            <p className="font-medium mb-1">No listings yet</p>
            <p className={`text-sm ${subtleText}`}>
              Add your first product to start selling.
            </p>
          </div>
        )}

        {listings.length > 0 && (
          <div className="space-y-3">
            {listings.map((l) => {
              const isActive = l.status === "active";
              return (
                <div
                  key={l.id}
                  className={`rounded-xl border p-4 ${cardClass}`}
                  data-testid={`listing-${l.id}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                            isActive
                              ? isDark
                                ? "bg-[#5BA3F5]/15 text-[#5BA3F5]"
                                : "bg-[#1B2A4A]/15 text-[#1B2A4A]"
                              : isDark
                                ? "bg-white/10 text-white/60"
                                : "bg-stone-200 text-stone-500"
                          }`}
                        >
                          {isActive ? "ACTIVE" : "DRAFT"}
                        </span>
                        <span className={`text-xs ${subtleText}`}>
                          {l.category}
                        </span>
                      </div>
                      <p className="font-bold truncate">{l.title}</p>
                      <p
                        className={`text-sm font-bold mt-1 ${
                          isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                        }`}
                      >
                        {formatPrice(l.priceMinor, country)}
                      </p>
                      <p className={`text-xs ${subtleText}`}>
                        {l.inventory} in stock
                      </p>
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      <button
                        onClick={() =>
                          updateListing(l.id, {
                            status: isActive ? "draft" : "active",
                          })
                        }
                        className={`p-2 rounded-full ${
                          isDark
                            ? "hover:bg-white/10 text-white/60"
                            : "hover:bg-stone-200 text-stone-500"
                        }`}
                        aria-label={isActive ? "Unpublish" : "Publish"}
                        data-testid={`toggle-listing-${l.id}`}
                      >
                        {isActive ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => removeListing(l.id)}
                        className={`p-2 rounded-full ${
                          isDark
                            ? "hover:bg-white/10 text-white/60"
                            : "hover:bg-stone-200 text-stone-500"
                        }`}
                        aria-label="Remove"
                        data-testid={`remove-listing-${l.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function NotApprovedState({ isDark }: { isDark: boolean }) {
  return (
    <div className="flex flex-col h-full w-full">
      <div
        className={`pt-12 pb-4 px-4 z-10 sticky top-0 ${
          isDark ? "bg-[#0F1525]" : "bg-[#fbeed3]"
        }`}
      >
        <h1 className="text-xl font-bold">Listings</h1>
      </div>
      <div className="px-6 py-12 text-center space-y-4">
        <p
          className={`text-sm ${
            isDark ? "text-white/50" : "text-stone-500"
          }`}
        >
          Become a vetted seller to manage listings.
        </p>
        <Link
          href="/seller/apply"
          className={`inline-block px-6 py-3 rounded-full font-bold ${
            isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
          }`}
        >
          Apply now
        </Link>
      </div>
    </div>
  );
}
