import React from "react";
import {
  Image,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";

interface BrandLogoProps {
  size?: "sm" | "md" | "lg";
  tagline?: string | null;
  /**
   * Force a specific variant. Defaults to following the active color scheme:
   * white wordmark on dark backgrounds, full-color wordmark on light.
   */
  variant?: "auto" | "color" | "white";
}

const SIZES = {
  sm: { height: 22 },
  md: { height: 34 },
  lg: { height: 48 },
} as const;

const ASPECT_RATIO = 1024 / 320;

const COLOR_SRC = require("@/assets/images/logo-color.png");
const WHITE_SRC = require("@/assets/images/logo-white.png");

export function BrandLogo({
  size = "md",
  tagline = null,
  variant = "auto",
}: BrandLogoProps) {
  const colors = useColors();
  const scheme = useColorScheme();
  const s = SIZES[size];

  const resolved =
    variant === "auto" ? (scheme === "dark" ? "white" : "color") : variant;
  const source = resolved === "white" ? WHITE_SRC : COLOR_SRC;

  return (
    <View style={styles.wrap}>
      <Image
        source={source}
        accessibilityLabel="Epplaa"
        resizeMode="contain"
        style={{ height: s.height, width: s.height * ASPECT_RATIO }}
      />
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
  tagline: {
    marginTop: 8,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    textAlign: "center",
  },
});
