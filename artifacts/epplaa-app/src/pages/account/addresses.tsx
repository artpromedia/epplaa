import { useState } from "react";
import { MapPin, Plus, Trash2, Pencil, Star } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useLocalStorage } from "@/lib/use-local-storage";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/hooks/use-toast";

interface Address {
  id: string;
  countryCode: string;
  label: string;
  recipient: string;
  line: string;
  city: string;
  phone: string;
  isDefault: boolean;
}

const EMPTY: Omit<Address, "id" | "isDefault" | "countryCode"> = {
  label: "Home",
  recipient: "",
  line: "",
  city: "",
  phone: "",
};

export default function Addresses() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { toast } = useToast();
  const [addresses, setAddresses] = useLocalStorage<Address[]>(
    "epplaa-addresses",
    [],
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ ...EMPTY, city: country.primaryCity });
  const showForm = editingId !== null;

  const cardClass = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";
  const subtleText = isDark ? "text-white/50" : "text-stone-500";
  const inputClass = `w-full px-3 py-2 rounded-lg border text-sm outline-none focus:ring-2 focus:ring-[#5BA3F5]/30 ${
    isDark
      ? "bg-black/40 border-white/10 text-white placeholder:text-white/30"
      : "bg-white border-stone-300 text-stone-900 placeholder:text-stone-400"
  }`;

  function startNew() {
    setDraft({ ...EMPTY, city: country.primaryCity });
    setEditingId("new");
  }

  function startEdit(a: Address) {
    setDraft({
      label: a.label,
      recipient: a.recipient,
      line: a.line,
      city: a.city,
      phone: a.phone,
    });
    setEditingId(a.id);
  }

  function cancel() {
    setEditingId(null);
  }

  function save() {
    if (!draft.recipient.trim() || !draft.line.trim() || !draft.phone.trim()) {
      toast({
        title: "Missing details",
        description: "Recipient, address, and phone are required.",
      });
      return;
    }
    if (editingId === "new") {
      const next: Address = {
        id: `addr_${Date.now()}`,
        countryCode: country.code,
        ...draft,
        isDefault: addresses.length === 0,
      };
      setAddresses((prev) => [next, ...prev]);
      toast({ title: "Address added" });
    } else {
      setAddresses((prev) =>
        prev.map((a) =>
          a.id === editingId ? { ...a, ...draft } : a,
        ),
      );
      toast({ title: "Address updated" });
    }
    setEditingId(null);
  }

  function remove(id: string) {
    setAddresses((prev) => {
      const filtered = prev.filter((a) => a.id !== id);
      const removed = prev.find((a) => a.id === id);
      if (removed?.isDefault && filtered.length > 0) {
        filtered[0] = { ...filtered[0], isDefault: true };
      }
      return filtered;
    });
    toast({ title: "Address removed" });
  }

  function setDefault(id: string) {
    setAddresses((prev) =>
      prev.map((a) => ({ ...a, isDefault: a.id === id })),
    );
  }

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Delivery Addresses" />
      <div className="px-4 pb-24 space-y-6">
        <p className={`text-sm ${subtleText}`}>
          Save addresses for faster checkout. New addresses default to{" "}
          {country.flag} {country.name}.
        </p>

        {addresses.length === 0 && !showForm && (
          <div className={`rounded-xl border p-6 text-center ${cardClass}`}>
            <MapPin className={`w-8 h-8 mx-auto mb-2 ${subtleText}`} />
            <p className="font-medium mb-1">No saved addresses yet</p>
            <p className={`text-sm ${subtleText}`}>
              Add your first delivery address to speed up checkout.
            </p>
          </div>
        )}

        {addresses.length > 0 && (
          <div className="space-y-3">
            {addresses.map((a) => (
              <div
                key={a.id}
                className={`rounded-xl border p-4 ${cardClass}`}
                data-testid={`address-${a.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-bold">{a.label}</span>
                      {a.isDefault && (
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                            isDark
                              ? "bg-[#5BA3F5]/15 text-[#5BA3F5]"
                              : "bg-[#1B2A4A]/15 text-[#1B2A4A]"
                          }`}
                        >
                          DEFAULT
                        </span>
                      )}
                      <span className={`text-xs ${subtleText}`}>
                        · {a.countryCode}
                      </span>
                    </div>
                    <p className="text-sm">{a.recipient}</p>
                    <p className={`text-sm ${subtleText}`}>
                      {a.line}, {a.city}
                    </p>
                    <p className={`text-sm ${subtleText}`}>{a.phone}</p>
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      onClick={() => startEdit(a)}
                      className={`p-2 rounded-full ${
                        isDark
                          ? "hover:bg-white/10 text-white/60"
                          : "hover:bg-stone-200 text-stone-500"
                      }`}
                      aria-label="Edit"
                      data-testid={`edit-address-${a.id}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => remove(a.id)}
                      className={`p-2 rounded-full ${
                        isDark
                          ? "hover:bg-white/10 text-white/60"
                          : "hover:bg-stone-200 text-stone-500"
                      }`}
                      aria-label="Remove"
                      data-testid={`remove-address-${a.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                {!a.isDefault && (
                  <button
                    onClick={() => setDefault(a.id)}
                    className={`mt-3 inline-flex items-center gap-1 text-xs font-medium ${
                      isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                    }`}
                    data-testid={`set-default-${a.id}`}
                  >
                    <Star className="w-3 h-3" /> Set as default
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {!showForm ? (
          <button
            onClick={startNew}
            className={`w-full flex items-center justify-center gap-2 py-3 rounded-full font-bold ${
              isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
            }`}
            data-testid="button-add-address"
          >
            <Plus className="w-5 h-5" />
            Add address
          </button>
        ) : (
          <div className={`rounded-xl border p-4 space-y-3 ${cardClass}`}>
            <div>
              <label className="block text-sm font-bold mb-1">Label</label>
              <input
                type="text"
                value={draft.label}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, label: e.target.value }))
                }
                placeholder="Home, Office, Mum's place..."
                className={inputClass}
                data-testid="input-label"
              />
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">Recipient</label>
              <input
                type="text"
                value={draft.recipient}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, recipient: e.target.value }))
                }
                placeholder="Full name"
                className={inputClass}
                data-testid="input-recipient"
              />
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">
                Address line
              </label>
              <input
                type="text"
                value={draft.line}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, line: e.target.value }))
                }
                placeholder="Street, building, apartment"
                className={inputClass}
                data-testid="input-line"
              />
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">City</label>
              <input
                type="text"
                value={draft.city}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, city: e.target.value }))
                }
                placeholder={country.primaryCity}
                className={inputClass}
                data-testid="input-city"
              />
            </div>
            <div>
              <label className="block text-sm font-bold mb-1">Phone</label>
              <input
                type="tel"
                value={draft.phone}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, phone: e.target.value }))
                }
                placeholder="+234 801 234 5678"
                className={inputClass}
                data-testid="input-phone"
              />
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={cancel}
                className={`flex-1 py-2 rounded-full font-medium ${
                  isDark
                    ? "bg-white/10 hover:bg-white/15 text-white"
                    : "bg-stone-200 hover:bg-stone-300 text-stone-900"
                }`}
                data-testid="button-cancel-address"
              >
                Cancel
              </button>
              <button
                onClick={save}
                className={`flex-1 py-2 rounded-full font-bold ${
                  isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
                }`}
                data-testid="button-save-address"
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
