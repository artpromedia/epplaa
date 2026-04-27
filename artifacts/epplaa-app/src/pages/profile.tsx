import { Settings, CreditCard, MapPin, ChevronRight } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { COUNTRIES, CountryCode } from "@/lib/countries";
import { ThemeToggle } from "@/components/theme-toggle";

export default function Profile() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country, setCountry } = useCountry();

  return (
    <div className="flex flex-col h-full w-full">
      <div className={`pt-12 pb-6 px-4 z-10 sticky top-0 ${isDark ? 'bg-[#050505]' : 'bg-[#fbeed3]'}`}>
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold">Profile</h1>
          <ThemeToggle />
        </div>
      </div>
      
      <div className="px-4 pb-20">
        <div className="flex items-center gap-4 mb-8">
          <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-[#ff00ff] to-[#00ffff] p-1">
            <div className={`w-full h-full rounded-full flex items-center justify-center text-2xl font-bold ${isDark ? 'bg-black text-white' : 'bg-white text-stone-900'}`}>
              EA
            </div>
          </div>
          <div>
            <h2 className="text-xl font-bold">Epplaa User</h2>
            <p className={`text-sm ${isDark ? 'text-white/50' : 'text-stone-500'}`}>@epplaa_fan</p>
          </div>
        </div>

        <div className="space-y-6">
          <div>
            <h3 className={`text-sm font-bold mb-3 uppercase tracking-wider ${isDark ? 'text-white/40' : 'text-stone-400'}`}>Region & Currency</h3>
            <div className={`rounded-xl border overflow-hidden ${isDark ? 'bg-white/5 border-white/10' : 'bg-white border-stone-400/35'}`}>
              
              <div className="p-3">
                <label className="block text-sm font-bold mb-2">Shopping Location</label>
                <div className="space-y-2">
                  {(Object.keys(COUNTRIES) as CountryCode[]).map((code) => {
                    const c = COUNTRIES[code];
                    const isSelected = country.code === code;
                    const isDisabled = c.status === "coming-soon";
                    
                    return (
                      <button
                        key={code}
                        onClick={() => !isDisabled && setCountry(code)}
                        disabled={isDisabled}
                        className={`w-full flex items-center justify-between p-3 rounded-lg border text-left transition-colors ${
                          isSelected 
                            ? (isDark ? 'bg-[#00ffff]/10 border-[#00ffff]/30' : 'bg-[#00b3b3]/10 border-[#00b3b3]/30')
                            : isDisabled
                              ? (isDark ? 'bg-black/20 border-white/5 opacity-50' : 'bg-stone-100 border-stone-200 opacity-50')
                              : (isDark ? 'bg-black/40 border-white/10 hover:bg-white/5' : 'bg-white border-stone-300 hover:bg-stone-50')
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-2xl leading-none">{c.flag}</span>
                          <div>
                            <p className={`font-bold ${isSelected ? (isDark ? 'text-[#00ffff]' : 'text-[#00b3b3]') : ''}`}>{c.name}</p>
                            <p className={`text-xs ${isDark ? 'text-white/50' : 'text-stone-500'}`}>{c.currency.code} ({c.currency.symbol})</p>
                          </div>
                        </div>
                        <div className="flex items-center">
                          {isDisabled && (
                            <span className={`text-[10px] font-bold px-2 py-1 rounded mr-2 ${isDark ? 'bg-white/10 text-white/50' : 'bg-stone-200 text-stone-500'}`}>
                              Soon
                            </span>
                          )}
                          {isSelected && (
                            <div className={`w-4 h-4 rounded-full flex items-center justify-center ${isDark ? 'bg-[#00ffff]' : 'bg-[#00b3b3]'}`}>
                              <div className={`w-1.5 h-1.5 rounded-full ${isDark ? 'bg-black' : 'bg-white'}`}></div>
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div>
            <h3 className={`text-sm font-bold mb-3 uppercase tracking-wider ${isDark ? 'text-white/40' : 'text-stone-400'}`}>Account</h3>
            <div className={`rounded-xl border overflow-hidden ${isDark ? 'bg-white/5 border-white/10' : 'bg-white border-stone-400/35'}`}>
              <button className={`w-full flex items-center justify-between p-4 border-b ${isDark ? 'border-white/10 hover:bg-white/5' : 'border-stone-200 hover:bg-stone-50'}`}>
                <div className="flex items-center gap-3">
                  <CreditCard className={`w-5 h-5 ${isDark ? 'text-white/70' : 'text-stone-500'}`} />
                  <span className="font-medium">Payment Methods</span>
                </div>
                <ChevronRight className={`w-4 h-4 ${isDark ? 'text-white/30' : 'text-stone-400'}`} />
              </button>
              <button className={`w-full flex items-center justify-between p-4 border-b ${isDark ? 'border-white/10 hover:bg-white/5' : 'border-stone-200 hover:bg-stone-50'}`}>
                <div className="flex items-center gap-3">
                  <MapPin className={`w-5 h-5 ${isDark ? 'text-white/70' : 'text-stone-500'}`} />
                  <span className="font-medium">Addresses</span>
                </div>
                <ChevronRight className={`w-4 h-4 ${isDark ? 'text-white/30' : 'text-stone-400'}`} />
              </button>
              <button className={`w-full flex items-center justify-between p-4 ${isDark ? 'hover:bg-white/5' : 'hover:bg-stone-50'}`}>
                <div className="flex items-center gap-3">
                  <Settings className={`w-5 h-5 ${isDark ? 'text-white/70' : 'text-stone-500'}`} />
                  <span className="font-medium">Settings</span>
                </div>
                <ChevronRight className={`w-4 h-4 ${isDark ? 'text-white/30' : 'text-stone-400'}`} />
              </button>
            </div>
          </div>
          
        </div>
      </div>
    </div>
  );
}
