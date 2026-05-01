import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClerkProvider } from "@clerk/clerk-react";
import { Dashboard } from "./pages/Dashboard";

const queryClient = new QueryClient();

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!publishableKey) {
  // Fail loudly at startup instead of silently rendering the app with broken auth.
  throw new Error("VITE_CLERK_PUBLISHABLE_KEY must be set for apps/studio.");
}

export default function App() {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <QueryClientProvider client={queryClient}>
        <Dashboard />
      </QueryClientProvider>
    </ClerkProvider>
  );
}
