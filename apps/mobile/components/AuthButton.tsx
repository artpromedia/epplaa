import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { useColors } from "@/hooks/useColors";

type Variant = "primary" | "secondary" | "outline" | "ghost";

interface AuthButtonProps {
  label: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function AuthButton({
  label,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  style,
  testID,
}: AuthButtonProps) {
  const colors = useColors();

  const palette = (() => {
    switch (variant) {
      case "secondary":
        return { bg: colors.secondary, fg: colors.secondaryForeground, border: colors.secondary };
      case "outline":
        return { bg: "transparent", fg: colors.foreground, border: colors.border };
      case "ghost":
        return { bg: "transparent", fg: colors.primary, border: "transparent" };
      case "primary":
      default:
        return { bg: colors.primary, fg: colors.primaryForeground, border: colors.primary };
    }
  })();

  const isDisabled = disabled || loading;

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: palette.bg,
          borderColor: palette.border,
          borderRadius: colors.radius + 4,
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.fg} />
      ) : (
        <Text style={[styles.label, { color: palette.fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 52,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  label: {
    fontFamily: "Inter_700Bold",
    fontWeight: "700",
    fontSize: 16,
    letterSpacing: 0.2,
  },
});
