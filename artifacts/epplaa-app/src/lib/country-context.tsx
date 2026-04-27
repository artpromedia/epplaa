import React, { createContext, useContext } from "react";
import { Country, CountryCode, COUNTRIES } from "./countries";
import { useGetMe, useUpdateMe } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

interface CountryContextState {
  country: Country;
  setCountry: (code: CountryCode) => void;
}

const CountryContext = createContext<CountryContextState | undefined>(undefined);

const DEFAULT_CODE: CountryCode = "NG";

function isLiveCode(code: string | null | undefined): code is CountryCode {
  if (!code) return false;
  const entry = COUNTRIES[code as CountryCode];
  return Boolean(entry) && entry.status === "live";
}

export function CountryProvider({ children }: { children: React.ReactNode }) {
  const meQuery = useGetMe();
  const updateMe = useUpdateMe();
  const qc = useQueryClient();

  const userCode = meQuery.data?.countryCode;
  const code: CountryCode = isLiveCode(userCode) ? userCode : DEFAULT_CODE;

  const setCountry = (next: CountryCode) => {
    if (!isLiveCode(next)) return;
    updateMe.mutate(
      { data: { countryCode: next } },
      { onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/me"] }) },
    );
  };

  return (
    <CountryContext.Provider value={{ country: COUNTRIES[code], setCountry }}>
      {children}
    </CountryContext.Provider>
  );
}

export function useCountry() {
  const context = useContext(CountryContext);
  if (context === undefined) throw new Error("useCountry must be used within a CountryProvider");
  return context;
}
