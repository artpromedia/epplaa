import React, { createContext, useContext, useState } from "react";
import { Country, CountryCode, COUNTRIES } from "./countries";

interface CountryContextState {
  country: Country;
  setCountry: (code: CountryCode) => void;
}

const CountryContext = createContext<CountryContextState | undefined>(undefined);

const STORAGE_KEY = "epplaa-country";
const DEFAULT_CODE: CountryCode = "NG";

function isLiveCode(code: string | null): code is CountryCode {
  if (!code) return false;
  const entry = COUNTRIES[code as CountryCode];
  return Boolean(entry) && entry.status === "live";
}

export function CountryProvider({ children }: { children: React.ReactNode }) {
  const [countryCode, setCountryCode] = useState<CountryCode>(() => {
    if (typeof window === "undefined") return DEFAULT_CODE;
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isLiveCode(saved)) return saved;
    return DEFAULT_CODE;
  });

  const setCountry = (code: CountryCode) => {
    if (!isLiveCode(code)) return;
    window.localStorage.setItem(STORAGE_KEY, code);
    setCountryCode(code);
  };

  const value = {
    country: COUNTRIES[countryCode],
    setCountry,
  };

  return (
    <CountryContext.Provider value={value}>
      {children}
    </CountryContext.Provider>
  );
}

export function useCountry() {
  const context = useContext(CountryContext);
  if (context === undefined) {
    throw new Error("useCountry must be used within a CountryProvider");
  }
  return context;
}
