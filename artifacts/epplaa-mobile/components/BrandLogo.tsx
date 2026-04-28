import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";

interface BrandLogoProps {
  size?: "sm" | "md" | "lg";
  tagline?: string | null;
}

const SIZES = {
  sm: { word: 22, dot: 6, gap: 4 },
  md: { word: 34, dot: 9, gap: 6 },
  lg: { word: 48, dot: 12, gap: 8 },
} as const;

export function BrandLogo({ size = "md", tagline = null }: BrandLogoProps) {
  const colors = useColors();
  const s = SIZES[size];
  return (
    <View style={styles.wrap}>
      <View style={[styles.row, { gap: s.gap }]}>
        <Text
          style={[
            styles.word,
            { color: colors.primary, fontSize: s.word, lineHeight: s.word * 1.05 },
          ]}
        >
          Epplaa
        </Text>
        <View
          style={{
            width: s.dot,
            height: s.dot,
            borderRadius: s.dot / 2,
            backgroundColor: colors.secondary,
            marginTop: s.word * 0.55,
          }}
        />
      </View>
      {tagline ? (
        <Text style={[styles.tagline, { color: colors.mutedForeground }]}>
          {tagline}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
  },
  word: {
    fontFamily: "Inter_700Bold",
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  tagline: {
    marginTop: 8,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    textAlign: "center",
  },
});
