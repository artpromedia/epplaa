import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
} from "react";
import { useLocalStorage } from "./use-local-storage";

interface OnboardingState {
  completed: boolean;
  interests: string[];
  notificationsOptIn: boolean;
  completedAtIso: string | null;
}

interface OnboardingContextValue extends OnboardingState {
  markComplete: (input: {
    interests: string[];
    notificationsOptIn: boolean;
  }) => void;
  reset: () => void;
}

const STORAGE_KEY = "epplaa-onboarding";
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
  const [state, setState] = useLocalStorage<OnboardingState>(STORAGE_KEY, DEFAULT);

  const markComplete = useCallback<OnboardingContextValue["markComplete"]>(
    ({ interests, notificationsOptIn }) => {
      setState({
        completed: true,
        interests,
        notificationsOptIn,
        completedAtIso: new Date().toISOString(),
      });
    },
    [setState],
  );

  const reset = useCallback(() => setState(DEFAULT), [setState]);

  const value = useMemo<OnboardingContextValue>(
    () => ({ ...state, markComplete, reset }),
    [state, markComplete, reset],
  );

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error("useOnboarding must be used within OnboardingProvider");
  return ctx;
}
