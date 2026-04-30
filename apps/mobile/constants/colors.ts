/**
 * Semantic design tokens for the Epplaa mobile app.
 *
 * Mirrors the "Lagos Sunset" palette defined in the sibling web artifact's
 * src/index.css so both surfaces share a cohesive identity.
 *
 * - Light: warm cream background, navy primary, sunset coral secondary.
 * - Dark : deep navy background, sky primary, warm coral secondary.
 *
 * Hex values were derived directly from the HSL custom properties in
 * artifacts/epplaa-app/src/index.css. When updating brand colors, update
 * both files together.
 */

const colors = {
  light: {
    text: "#1c1a18",
    tint: "#1B2A4A",

    background: "#fbeed3",
    foreground: "#1c1a18",

    card: "#fff5d8",
    cardForeground: "#1c1a18",

    primary: "#1B2A4A",
    primaryForeground: "#ffffff",

    secondary: "#E6502E",
    secondaryForeground: "#ffffff",

    muted: "#ddd8d2",
    mutedForeground: "#6e6760",

    accent: "#1B2A4A",
    accentForeground: "#ffffff",

    destructive: "#e5413e",
    destructiveForeground: "#ffffff",

    border: "#d2cdc8",
    input: "#d2cdc8",
  },

  dark: {
    text: "#ffffff",
    tint: "#5BA3F5",

    background: "#0F1525",
    foreground: "#ffffff",

    card: "#171C30",
    cardForeground: "#ffffff",

    primary: "#5BA3F5",
    primaryForeground: "#000000",

    secondary: "#FF8855",
    secondaryForeground: "#000000",

    muted: "#232940",
    mutedForeground: "#97a0b5",

    accent: "#5BA3F5",
    accentForeground: "#000000",

    destructive: "#e5413e",
    destructiveForeground: "#ffffff",

    border: "#2b324a",
    input: "#2b324a",
  },

  radius: 12,
};

export default colors;
