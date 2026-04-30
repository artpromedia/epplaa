import { Stack } from "expo-router";
import React from "react";

/**
 * Auth flow stack.
 *
 * Header is hidden by default — each screen uses a custom branded
 * header (`AuthScaffold`) so headings line up with the welcome screen.
 */
export default function AuthLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="sign-up" />
      <Stack.Screen name="phone" />
      <Stack.Screen name="verify" />
    </Stack>
  );
}
