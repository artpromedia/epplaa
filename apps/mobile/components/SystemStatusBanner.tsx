import { Feather } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, Text, View, useColorScheme } from "react-native";
import { useRateLimitStoreBanner } from "@workspace/api-client-react";

/**
 * Small dismissible status banner shown to mobile users when the API
 * reports its rate-limit store as degraded. Copy is intentionally
 * generic — no internal terminology like "Redis" or "rate-limit
 * bucket" — so end users get useful context without leaking ops
 * details.
 *
 * The polling/dismissal logic lives in the shared
 * `useRateLimitStoreBanner` hook so this banner stays consistent
 * with the shopper app and the manufacturer portal.
 */
export function SystemStatusBanner() {
  const { isDegraded, isDismissed, dismiss } = useRateLimitStoreBanner();
  const scheme = useColorScheme();
  const isDark = scheme === "dark";

  if (!isDegraded || isDismissed) return null;

  const accent = isDark ? "#FF8855" : "#E6502E";
  const background = isDark ? "rgba(255,136,85,0.12)" : "#FFE7D7";
  const textColor = isDark ? "#FFD9C4" : "#7A2A14";

  return (
    <View
      accessibilityRole="alert"
      testID="banner-system-status-degraded"
      style={[
        styles.container,
        {
          backgroundColor: background,
          borderBottomColor: accent,
        },
      ]}
    >
      <Feather name="alert-triangle" size={16} color={accent} style={styles.icon} />
      <Text style={[styles.message, { color: textColor }]}>
        Some actions may be slower than usual — we’re working on it.
      </Text>
      <Pressable
        onPress={dismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss status notice"
        testID="button-system-status-dismiss"
        hitSlop={8}
        style={styles.dismiss}
      >
        <Feather name="x" size={14} color={textColor} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  icon: {
    marginTop: 2,
  },
  message: {
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
  },
  dismiss: {
    padding: 4,
  },
});
