import { useColorScheme } from "react-native";

import colors from "@/constants/colors";

/**
 * Returns the design tokens for the current color scheme.
 *
 * The returned object contains all color tokens for the active palette
 * plus scheme-independent values like `radius`. Falls back to the light
 * palette when no `dark` key is defined in constants/colors.ts.
 */
export function useColors() {
  const scheme = useColorScheme();
  const palette =
    scheme === "dark" && "dark" in colors && colors.dark
      ? colors.dark
      : colors.light;
  return { ...palette, radius: colors.radius };
}
