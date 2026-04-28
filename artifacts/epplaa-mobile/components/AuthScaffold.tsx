import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BrandLogo } from "@/components/BrandLogo";
import { useColors } from "@/hooks/useColors";

interface AuthScaffoldProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Optional footer rendered below scroll content (e.g. switch links). */
  footer?: ReactNode;
  /** Hide the back button (e.g. when this is the first screen in the stack). */
  hideBack?: boolean;
}

/**
 * Shared chrome for every auth screen: branded header, back button,
 * heading copy, and a keyboard-aware scroll body.
 *
 * Each screen owns its own form fields and CTAs but inherits the
 * same scaffold so spacing / typography / safe-area handling stay
 * consistent across sign-in, sign-up, phone, and verify.
 */
export function AuthScaffold({
  title,
  subtitle,
  children,
  footer,
  hideBack = false,
}: AuthScaffoldProps) {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 12,
            borderBottomColor: colors.border,
          },
        ]}
      >
        {hideBack ? (
          <View style={styles.headerSlot} />
        ) : (
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
            style={({ pressed }) => [
              styles.backBtn,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                borderRadius: colors.radius,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
            hitSlop={8}
            testID="auth-back"
          >
            <Feather name="arrow-left" size={18} color={colors.foreground} />
          </Pressable>
        )}
        <BrandLogo size="sm" />
        <View style={styles.headerSlot} />
      </View>

      <KeyboardAwareScrollViewCompat
        bottomOffset={32}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.body,
          { paddingBottom: insets.bottom + 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.titleBlock}>
          <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        <View style={styles.content}>{children}</View>

        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerSlot: {
    width: 36,
    height: 36,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  body: {
    paddingHorizontal: 24,
    paddingTop: 24,
    flexGrow: 1,
  },
  titleBlock: {
    marginBottom: 24,
  },
  title: {
    fontFamily: "Inter_700Bold",
    fontWeight: "800",
    fontSize: 26,
    lineHeight: 32,
    letterSpacing: -0.4,
  },
  subtitle: {
    marginTop: 6,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 20,
  },
  content: {
    gap: 14,
  },
  footer: {
    marginTop: 24,
    alignItems: "center",
  },
});
