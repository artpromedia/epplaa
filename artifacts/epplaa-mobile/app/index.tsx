import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AuthButton } from "@/components/AuthButton";
import { BrandLogo } from "@/components/BrandLogo";
import { useColors } from "@/hooks/useColors";

/**
 * In-app splash / welcome screen.
 *
 * The native splash (configured in app.json) hides as soon as fonts load,
 * dropping the user here. This screen acts as the "front door":
 *   - a branded hero,
 *   - quick value props,
 *   - and the entry points into the auth flows.
 *
 * Once real auth is wired (Clerk + phone OTP, mirroring the web app),
 * this screen should redirect to "(tabs)" when a session already exists.
 */
export default function WelcomeScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const isDark = scheme === "dark";

  // Brand-tinted gradient that mirrors the web onboarding hero.
  const gradient = isDark
    ? (["#0F1525", "#171C30", "#1B2240"] as const)
    : (["#fbeed3", "#fff5d8", "#ffe7c2"] as const);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <StatusBar style={isDark ? "light" : "dark"} />
      <LinearGradient colors={gradient} style={StyleSheet.absoluteFill} />

      <View
        style={[
          styles.content,
          { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24 },
        ]}
      >
        <View style={styles.hero}>
          <BrandLogo size="lg" tagline="Live shopping across Africa" />
        </View>

        <View style={styles.featureList}>
          <Feature
            icon="globe"
            title="Shop across 16 markets"
            body="Discover hosts going live in your city and across the continent."
          />
          <Feature
            icon="video"
            title="Tap to buy in real time"
            body="Watch streams, ask questions, and check out without leaving the show."
          />
          <Feature
            icon="shield"
            title="Buyer protection on every order"
            body="Secure escrow with refunds if your item never arrives."
          />
        </View>

        <View style={styles.ctaBlock}>
          <AuthButton
            label="Create an account"
            variant="primary"
            onPress={() => router.push("/(auth)/sign-up")}
            testID="welcome-cta-sign-up"
          />
          <AuthButton
            label="I already have an account"
            variant="outline"
            onPress={() => router.push("/(auth)/sign-in")}
            testID="welcome-cta-sign-in"
          />
          <Pressable
            onPress={() => router.push("/(auth)/phone")}
            style={styles.phoneRow}
            testID="welcome-cta-phone"
          >
            <Feather
              name="smartphone"
              size={16}
              color={colors.secondary}
              style={{ marginRight: 6 }}
            />
            <Text style={[styles.phoneText, { color: colors.secondary }]}>
              Continue with phone instead
            </Text>
          </Pressable>
          <Text style={[styles.legal, { color: colors.mutedForeground }]}>
            By continuing, you agree to Epplaa's Terms and Privacy Policy.
          </Text>
        </View>
      </View>
    </View>
  );
}

function Feature({
  icon,
  title,
  body,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  body: string;
}) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.feature,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderRadius: colors.radius + 4,
        },
      ]}
    >
      <View
        style={[
          styles.featureIcon,
          { backgroundColor: colors.secondary + "1f" },
        ]}
      >
        <Feather name={icon} size={18} color={colors.secondary} />
      </View>
      <View style={styles.featureCopy}>
        <Text style={[styles.featureTitle, { color: colors.foreground }]}>
          {title}
        </Text>
        <Text
          style={[styles.featureBody, { color: colors.mutedForeground }]}
        >
          {body}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: "space-between",
  },
  hero: {
    alignItems: "center",
    marginTop: 24,
  },
  featureList: {
    gap: 12,
    marginVertical: 24,
  },
  feature: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
  },
  featureIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  featureCopy: {
    flex: 1,
  },
  featureTitle: {
    fontFamily: "Inter_700Bold",
    fontWeight: "700",
    fontSize: 14,
    marginBottom: 2,
  },
  featureBody: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 16,
  },
  ctaBlock: {
    gap: 10,
  },
  phoneRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
  },
  phoneText: {
    fontFamily: "Inter_600SemiBold",
    fontWeight: "600",
    fontSize: 14,
  },
  legal: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    textAlign: "center",
    marginTop: 4,
    lineHeight: 14,
  },
});
