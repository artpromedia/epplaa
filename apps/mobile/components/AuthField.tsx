import React, { forwardRef, useState } from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";

import { useColors } from "@/hooks/useColors";

interface AuthFieldProps extends TextInputProps {
  label: string;
  error?: string | null;
  helperText?: string | null;
  /** Optional content to render at the right edge (e.g. show/hide toggle). */
  trailing?: React.ReactNode;
  /** Optional content to render at the left edge (e.g. country code). */
  leading?: React.ReactNode;
}

export const AuthField = forwardRef<TextInput, AuthFieldProps>(function AuthField(
  { label, error, helperText, trailing, leading, style, onFocus, onBlur, ...rest },
  ref,
) {
  const colors = useColors();
  const [focused, setFocused] = useState(false);
  const borderColor = error
    ? colors.destructive
    : focused
      ? colors.primary
      : colors.border;

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.foreground }]}>{label}</Text>
      <View
        style={[
          styles.row,
          {
            borderColor,
            borderRadius: colors.radius,
            backgroundColor: colors.card,
          },
        ]}
      >
        {leading ? <View style={styles.adornment}>{leading}</View> : null}
        <TextInput
          ref={ref}
          {...rest}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          placeholderTextColor={colors.mutedForeground}
          style={[
            styles.input,
            { color: colors.foreground },
            style,
          ]}
        />
        {trailing ? <View style={styles.adornment}>{trailing}</View> : null}
      </View>
      {error ? (
        <Text style={[styles.helper, { color: colors.destructive }]}>{error}</Text>
      ) : helperText ? (
        <Text style={[styles.helper, { color: colors.mutedForeground }]}>
          {helperText}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    gap: 6,
  },
  label: {
    fontFamily: "Inter_600SemiBold",
    fontWeight: "600",
    fontSize: 13,
    letterSpacing: 0.2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    paddingHorizontal: 14,
    minHeight: 52,
  },
  input: {
    flex: 1,
    fontFamily: "Inter_500Medium",
    fontSize: 16,
    paddingVertical: 12,
  },
  adornment: {
    paddingHorizontal: 4,
  },
  helper: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    marginTop: 2,
  },
});
