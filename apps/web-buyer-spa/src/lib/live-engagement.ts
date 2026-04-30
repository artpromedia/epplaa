// Pool of fake viewers + their messages used to bring the live screen to life.
// Each render spawns bot messages on a 2.5–4s cadence. Colors are tailwind class
// pairs so the bubble label tints match the existing chat styling.

export interface BotViewer {
  username: string;
  avatarFallback: string;
  fallbackBg: string;
  darkFallbackBg: string;
  fallbackColor: string;
  darkFallbackColor: string;
  color: string;
  darkColor: string;
}

export const BOT_VIEWERS: BotViewer[] = [
  {
    username: "Tunde",
    avatarFallback: "T",
    fallbackBg: "bg-stone-300/45",
    darkFallbackBg: "bg-white/20",
    fallbackColor: "text-stone-900",
    darkFallbackColor: "text-white",
    color: "text-stone-700",
    darkColor: "text-white/70",
  },
  {
    username: "Chioma_99",
    avatarFallback: "C",
    fallbackBg: "bg-[#1B2A4A]/20",
    darkFallbackBg: "bg-[#5BA3F5]/20",
    fallbackColor: "text-[#1B2A4A]",
    darkFallbackColor: "text-[#5BA3F5]",
    color: "text-[#1B2A4A]",
    darkColor: "text-[#5BA3F5]",
  },
  {
    username: "Femi",
    avatarFallback: "F",
    fallbackBg: "bg-[#1B2A4A]/20",
    darkFallbackBg: "bg-[#5BA3F5]/20",
    fallbackColor: "text-[#1B2A4A]",
    darkFallbackColor: "text-[#5BA3F5]",
    color: "text-stone-700",
    darkColor: "text-white/70",
  },
  {
    username: "Olu",
    avatarFallback: "O",
    fallbackBg: "bg-stone-300/45",
    darkFallbackBg: "bg-white/20",
    fallbackColor: "text-stone-900",
    darkFallbackColor: "text-white",
    color: "text-[#E6502E]",
    darkColor: "text-[#FF8855]",
  },
  {
    username: "Amaka",
    avatarFallback: "A",
    fallbackBg: "bg-[#E6502E]/20",
    darkFallbackBg: "bg-[#FF8855]/20",
    fallbackColor: "text-[#E6502E]",
    darkFallbackColor: "text-[#FF8855]",
    color: "text-stone-700",
    darkColor: "text-white/70",
  },
  {
    username: "Bayo_Trades",
    avatarFallback: "B",
    fallbackBg: "bg-[#E6502E]/20",
    darkFallbackBg: "bg-[#FF8855]/20",
    fallbackColor: "text-[#E6502E]",
    darkFallbackColor: "text-[#FF8855]",
    color: "text-[#1B2A4A]",
    darkColor: "text-[#5BA3F5]",
  },
  {
    username: "Ngozi.K",
    avatarFallback: "N",
    fallbackBg: "bg-[#1B2A4A]/20",
    darkFallbackBg: "bg-[#5BA3F5]/20",
    fallbackColor: "text-[#1B2A4A]",
    darkFallbackColor: "text-[#5BA3F5]",
    color: "text-stone-700",
    darkColor: "text-white/70",
  },
  {
    username: "Kwame_GH",
    avatarFallback: "K",
    fallbackBg: "bg-stone-300/45",
    darkFallbackBg: "bg-white/20",
    fallbackColor: "text-stone-900",
    darkFallbackColor: "text-white",
    color: "text-[#E6502E]",
    darkColor: "text-[#FF8855]",
  },
  {
    username: "Wanjiru",
    avatarFallback: "W",
    fallbackBg: "bg-[#E6502E]/20",
    darkFallbackBg: "bg-[#FF8855]/20",
    fallbackColor: "text-[#E6502E]",
    darkFallbackColor: "text-[#FF8855]",
    color: "text-stone-700",
    darkColor: "text-white/70",
  },
];

export const BOT_MESSAGES: string[] = [
  "How much for the blue one?",
  "Ship to Surulere?",
  "I need this sharp sharp",
  "Is the material stretchy?",
  "Will you drop the price?",
  "Can I pay on delivery?",
  "Pls show the back",
  "Size L still available?",
  "Bundle deal pls 🙏",
  "Looks fire 🔥",
  "Sending DM now",
  "Box locker ko?",
  "Shipping to Accra?",
  "When next live?",
  "Beautiful color tbh",
  "First time here, hi everyone",
  "Mama said get two",
  "Just bought! 🛒",
  "Quality looks legit",
  "Please restock the small",
];

export function randomBotViewer(): BotViewer {
  return BOT_VIEWERS[Math.floor(Math.random() * BOT_VIEWERS.length)];
}

export function randomBotMessage(): string {
  return BOT_MESSAGES[Math.floor(Math.random() * BOT_MESSAGES.length)];
}

// Format a viewer count back into the "1.2K", "856", "12.4K" style used across
// the app. Keeps single-K precision; everything under 1000 stays as a raw int.
export function formatViewerCount(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.floor(n)));
  return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
}

// Parse "2.4K" / "856" back to a number so we can animate from the seed value.
export function parseViewerCount(s: string): number {
  const trimmed = s.trim();
  if (trimmed.toUpperCase().endsWith("K")) {
    return Math.round(parseFloat(trimmed) * 1000);
  }
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : 0;
}

// Random walk for viewer count — net positive bias so streams trend up over the
// 30-second demo window, but with realistic dips.
export function nextViewerDelta(): number {
  const r = Math.random();
  if (r < 0.55) return Math.floor(Math.random() * 12) + 1; // +1..+12
  if (r < 0.85) return -(Math.floor(Math.random() * 6) + 1); // -1..-6
  return Math.floor(Math.random() * 30) - 5; // occasional bigger swing
}
