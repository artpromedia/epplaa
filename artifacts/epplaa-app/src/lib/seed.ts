export const SEED_STREAMS = [
  {
    id: "feature",
    hostName: "Ada Beauty",
    hostAvatar: "/images/lagos-avatar-2.png",
    viewerCount: "2.4K",
    posterImage: "/images/lagos-host-stream.png",
    title: "Naija Beauty Haul! Glow up szn ✨",
    currentProductId: "prod-1",
  },
  {
    id: "stream-2",
    hostName: "TechBoy",
    hostAvatar: "/images/lagos-avatar-1.png",
    viewerCount: "856",
    posterImage: "/images/lagos-feed-2.png",
    title: "Shenzhen tech drops 🔥",
    currentProductId: "prod-2",
  },
  {
    id: "stream-3",
    hostName: "Chika Styles",
    hostAvatar: "/images/lagos-avatar-2.png",
    viewerCount: "1.2K",
    posterImage: "/images/lagos-feed-1.png",
    title: "Premium Ankara fits, grab yours!",
    currentProductId: "prod-3",
  },
  {
    id: "stream-4",
    hostName: "Kelechi Gadgets",
    hostAvatar: "/images/lagos-avatar-1.png",
    viewerCount: "432",
    posterImage: "/images/lagos-feed-2.png",
    title: "Unboxing the latest power banks",
    currentProductId: "prod-4",
  },
  {
    id: "stream-5",
    hostName: "Bisi Essentials",
    hostAvatar: "/images/lagos-avatar-2.png",
    viewerCount: "920",
    posterImage: "/images/lagos-host-stream.png",
    title: "Home decor imported direct!",
    currentProductId: "prod-5",
  },
  {
    id: "stream-6",
    hostName: "Emeka Fresh",
    hostAvatar: "/images/lagos-avatar-1.png",
    viewerCount: "3.1K",
    posterImage: "/images/lagos-feed-1.png",
    title: "Sneaker drop - don't miss out",
    currentProductId: "prod-6",
  },
];

export const SEED_PRODUCTS = [
  {
    id: "prod-1",
    title: "Premium Ankara Two-Piece Set - Lagos Fashion Week Edition",
    priceMinor: 2450000, // 24,500 NGN
    originalPriceMinor: 3200000,
    originCountry: "Nigeria",
    originLabel: "Made in Nigeria",
    sellerName: "Ada's Boutique",
    sellerAvatar: "/images/lagos-avatar-2.png",
    rating: 4.8,
    soldCount: 124,
    isLiveNow: true,
    images: [
      "/images/lagos-product-carousel-1.png",
      "/images/lagos-product-serum.png",
      "/images/lagos-feed-1.png",
    ],
    variants: [
      { name: "Size", options: ["S", "M", "L", "XL"] }
    ],
  },
  {
    id: "prod-2",
    title: "Tokyo Glass Skin Serum - 100% Authentic",
    priceMinor: 1850000, // 18,500 NGN
    originalPriceMinor: 2100000,
    originCountry: "Japan",
    originLabel: "Imported from Japan",
    sellerName: "Glow Imports",
    sellerAvatar: "/images/lagos-avatar-1.png",
    rating: 4.9,
    soldCount: 856,
    isLiveNow: true,
    images: [
      "/images/lagos-product-serum.png",
    ],
    variants: [],
  },
  {
    id: "prod-3",
    title: "AirMax Imports Direct - High Quality Sound",
    priceMinor: 4500000,
    originalPriceMinor: 5000000,
    originCountry: "China",
    originLabel: "Imported from Shenzhen",
    sellerName: "TechBoy Store",
    sellerAvatar: "/images/lagos-avatar-1.png",
    rating: 4.6,
    soldCount: 320,
    isLiveNow: true,
    images: [
      "/images/lagos-feed-1.png",
    ],
    variants: [
      { name: "Color", options: ["Black", "White", "Blue"] }
    ],
  },
  {
    id: "prod-4",
    title: "20,000mAh Fast Charging Power Bank",
    priceMinor: 1250000,
    originalPriceMinor: 1500000,
    originCountry: "China",
    originLabel: "Imported",
    sellerName: "Kelechi Gadgets",
    sellerAvatar: "/images/lagos-avatar-1.png",
    rating: 4.5,
    soldCount: 1500,
    isLiveNow: false,
    images: [
      "/images/lagos-feed-2.png",
    ],
    variants: [],
  },
];

export const SEED_COMMENTS = [
  { username: "Tunde", avatar: "/images/lagos-avatar-1.png", text: "How much for the blue one?", color: "text-stone-500", darkColor: "text-white/50" },
  { username: "Chioma_99", avatarFallback: "C", fallbackBg: "bg-[#00b3b3]/20", darkFallbackBg: "bg-[#00ffff]/20", fallbackColor: "text-[#00b3b3]", darkFallbackColor: "text-[#00ffff]", text: "Ship to Surulere?", color: "text-[#00b3b3]", darkColor: "text-[#00ffff]" },
  { username: "Femi", avatarFallback: "F", fallbackBg: "bg-[#00b3b3]/20", darkFallbackBg: "bg-[#00ffff]/20", fallbackColor: "text-[#00b3b3]", darkFallbackColor: "text-[#00ffff]", text: "Na which size you wear?", color: "text-stone-500", darkColor: "text-white/50" },
  { username: "Olu", avatarFallback: "O", fallbackBg: "bg-stone-300/45", darkFallbackBg: "bg-white/20", fallbackColor: "text-stone-900", darkFallbackColor: "text-white", text: "I need this sharp sharp", color: "text-[#d900d9]", darkColor: "text-[#ff00ff]" },
  { username: "Amaka", avatar: "/images/lagos-avatar-2.png", text: "Is the material stretchy?", color: "text-stone-500", darkColor: "text-white/50" },
  { username: "Bayo_Trades", avatarFallback: "B", fallbackBg: "bg-[#d900d9]/20", darkFallbackBg: "bg-[#ff00ff]/20", fallbackColor: "text-[#d900d9]", darkFallbackColor: "text-[#ff00ff]", text: "Will you drop the price?", color: "text-[#00b3b3]", darkColor: "text-[#00ffff]" },
];
