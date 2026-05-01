/**
 * Clerk Expo SDK wiring.
 *
 * Token cache: Clerk's mobile SDK delegates session-token storage to a
 * `TokenCache` you supply. We use `expo-secure-store` (Keychain on iOS,
 * EncryptedSharedPreferences-backed Keystore on Android). Never use
 * AsyncStorage here — it's unencrypted on disk.
 *
 * The publishable key is read from the EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY
 * environment variable so it ships in the bundle. Clerk's publishable key
 * is safe to bundle (it's the public half); the secret key never leaves
 * the API monolith.
 */

import * as SecureStore from "expo-secure-store";
import type { TokenCache } from "@clerk/clerk-expo";

const KEY_PREFIX = "clerk-token-";

export const tokenCache: TokenCache = {
  async getToken(key) {
    try {
      return (await SecureStore.getItemAsync(KEY_PREFIX + key)) ?? null;
    } catch {
      // SecureStore can throw if the device's secure enclave is unavailable;
      // returning null forces Clerk to fetch a fresh token rather than crash.
      return null;
    }
  },
  async saveToken(key, value) {
    try {
      await SecureStore.setItemAsync(KEY_PREFIX + key, value);
    } catch {
      // Treated as ephemeral — Clerk will re-issue on next call.
    }
  },
  async clearToken(key) {
    try {
      await SecureStore.deleteItemAsync(KEY_PREFIX + key);
    } catch {
      // ignore
    }
  },
};

export const CLERK_PUBLISHABLE_KEY =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";

if (!CLERK_PUBLISHABLE_KEY) {
  // Don't throw — surface a clear console warning instead so the app still
  // boots in CI/preview environments where the key isn't configured.
  // The ClerkProvider in app/_layout.tsx will fail loudly when the user
  // attempts to authenticate.
  // eslint-disable-next-line no-console
  console.warn(
    "[clerk] EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is not set. Sign-in will fail.",
  );
}
