import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { ClerkProvider } from "@clerk/clerk-expo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { SystemStatusBanner } from "@/components/SystemStatusBanner";
import { useCsrfToken } from "@/lib/csrf";
import { CLERK_PUBLISHABLE_KEY, tokenCache } from "@/lib/clerk";

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  // CSRF wiring is mounted (symmetrical with the SPAs) but disabled today:
  // mobile authenticates with Clerk bearer tokens and has no cookie jar, so
  // the server's CSRF middleware exempts every request we send. When a
  // cookie-session surface lands on mobile (live-chat WebView, session bridge,
  // etc.) flip `enabled` to `true` and pass the user id + API base URL.
  // See `@/lib/csrf` for the full ship-or-skip rationale.
  useCsrfToken({ enabled: false });

  // Auth and tabs both render header-less stacks; per-screen options
  // are configured inside each (auth)/_layout.tsx and (tabs)/_layout.tsx.
  //
  // The system status banner sits above the navigator so it appears on
  // every screen (auth, tabs, modals). Wrapped in a flex column so the
  // Stack fills the remaining vertical space below the banner.
  return (
    <View style={{ flex: 1 }}>
      <SystemStatusBanner />
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(tabs)" />
        </Stack>
      </View>
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <ClerkProvider tokenCache={tokenCache} publishableKey={CLERK_PUBLISHABLE_KEY}>
      <SafeAreaProvider>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <GestureHandlerRootView>
              <KeyboardProvider>
                <RootLayoutNav />
              </KeyboardProvider>
            </GestureHandlerRootView>
          </QueryClientProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </ClerkProvider>
  );
}
