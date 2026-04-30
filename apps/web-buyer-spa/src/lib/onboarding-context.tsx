import { createContext, ReactNode, useCallback, useContext, useMemo } from "react";
import { useGetOnboarding, useCompleteOnboarding } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

interface OnboardingState {
  completed: boolean;
  interests: string[];
  notificationsOptIn: boolean;
  completedAtIso: string | null;
}

interface OnboardingContextValue extends OnboardingState {
  markComplete: (input: { interests: string[]; notificationsOptIn: boolean }) => void;
  reset: () => void;
}

const DEFAULT: OnboardingState = {
  completed: false,
  interests: [],
  notificationsOptIn: false,
  completedAtIso: null,
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export const ONBOARDING_INTERESTS = [
  "Beauty",
  "Fashion",
  "Phones",
  "Home",
  "Snacks",
  "Wellness",
  "Kids",
  "Auto",
];

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const query = useGetOnboarding();
  const qc = useQueryClient();
  const completeMut = useCompleteOnboarding({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/onboarding"] }),
    },
  });

  const state: OnboardingState = useMemo(() => {
    const data = query.data;
    if (!data) return DEFAULT;
    return {
      completed: data.completed,
      interests: data.interests,
      notificationsOptIn: data.notificationsOptIn,
      completedAtIso: data.completedAtIso ?? null,
    };
  }, [query.data]);

  const markComplete = useCallback<OnboardingContextValue["markComplete"]>(
    ({ interests, notificationsOptIn }) => {
      qc.setQueryData(["/api/onboarding"], {
        completed: true,
        interests,
        notificationsOptIn,
        completedAtIso: new Date().toISOString(),
      });
      completeMut.mutate({ data: { interests, notificationsOptIn } });
    },
    [completeMut, qc],
  );

  const reset = useCallback(() => {
    qc.setQueryData(["/api/onboarding"], DEFAULT);
    completeMut.mutate({ data: { interests: [], notificationsOptIn: false } });
  }, [completeMut, qc]);

  const value = useMemo<OnboardingContextValue>(
    () => ({ ...state, markComplete, reset }),
    [state, markComplete, reset],
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding() {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error("useOnboarding must be used within OnboardingProvider");
  return ctx;
}
