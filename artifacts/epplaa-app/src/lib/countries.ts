export type CountryCode = "NG" | "GH" | "KE" | "ZA" | "CI";

export interface PaymentMethod {
  id: string;          // "paystack-card" | "flutterwave-momo" | "mpesa" | "bank-transfer" | "ussd" | "cod"
  label: string;
  iconKey: string;     // map in UI
}

export interface FulfillmentOption {
  id: string;          // "epplaa-box" | "pudo" | "home-delivery"
  label: string;
  description: string; // e.g. "Smart locker pickup, free", "Pick up at partner store", "Door delivery via Kwik / Glovo / GIG"
  feeMinor: number;    // in minor units of the country's currency (e.g. kobo for NGN), 0 = free
  etaLabel: string;    // "Same day", "1-2 days"
}

export interface Country {
  code: CountryCode;
  name: string;        // "Nigeria"
  flag: string;        // emoji or icon key
  currency: {
    code: string;      // "NGN"
    symbol: string;    // "₦"
    decimals: number;  // 2
    minorPerMajor: number; // 100
  };
  paymentMethods: PaymentMethod[];
  fulfillmentOptions: FulfillmentOption[];
  primaryCity: string;     // "Lagos"
  status: "live" | "coming-soon";
}

export const COUNTRIES: Record<CountryCode, Country> = {
  NG: {
    code: "NG",
    name: "Nigeria",
    flag: "🇳🇬",
    currency: {
      code: "NGN",
      symbol: "₦",
      decimals: 2,
      minorPerMajor: 100,
    },
    primaryCity: "Lagos",
    status: "live",
    paymentMethods: [
      { id: "paystack-card", label: "Card via Paystack", iconKey: "credit-card" },
      { id: "flutterwave-bank", label: "Bank Transfer", iconKey: "landmark" },
      { id: "ussd", label: "USSD", iconKey: "smartphone" },
      { id: "cod", label: "Pay on Collection", iconKey: "banknote" },
    ],
    fulfillmentOptions: [
      {
        id: "epplaa-box",
        label: "Epplaa Box Locker",
        description: "Pick up from smart locker near you.",
        feeMinor: 0,
        etaLabel: "1-2 days",
      },
      {
        id: "pudo",
        label: "PUDO Pickup Partner",
        description: "Pick up from a verified local shop.",
        feeMinor: 50000, // 500 NGN
        etaLabel: "1-2 days",
      },
      {
        id: "home-delivery",
        label: "Home Delivery",
        description: "Via Glovo / GIG. Arrives today by 6PM.",
        feeMinor: 250000, // 2500 NGN
        etaLabel: "Same day",
      },
    ],
  },
  GH: {
    code: "GH",
    name: "Ghana",
    flag: "🇬🇭",
    currency: {
      code: "GHS",
      symbol: "GH₵",
      decimals: 2,
      minorPerMajor: 100,
    },
    primaryCity: "Accra",
    status: "coming-soon",
    paymentMethods: [
      { id: "mtn-momo", label: "MTN Mobile Money", iconKey: "smartphone" },
    ],
    fulfillmentOptions: [
      {
        id: "home-delivery",
        label: "Home Delivery",
        description: "Standard delivery",
        feeMinor: 5000, // 50 GHS
        etaLabel: "1-3 days",
      },
    ],
  },
  KE: {
    code: "KE",
    name: "Kenya",
    flag: "🇰🇪",
    currency: {
      code: "KES",
      symbol: "KSh ",
      decimals: 2,
      minorPerMajor: 100,
    },
    primaryCity: "Nairobi",
    status: "coming-soon",
    paymentMethods: [
      { id: "mpesa", label: "M-Pesa", iconKey: "smartphone" },
    ],
    fulfillmentOptions: [
      {
        id: "pickup",
        label: "Pickup Location",
        description: "Collect from partner",
        feeMinor: 10000, // 100 KES
        etaLabel: "1-2 days",
      },
    ],
  },
  ZA: {
    code: "ZA",
    name: "South Africa",
    flag: "🇿🇦",
    currency: {
      code: "ZAR",
      symbol: "R",
      decimals: 2,
      minorPerMajor: 100,
    },
    primaryCity: "Johannesburg",
    status: "coming-soon",
    paymentMethods: [
      { id: "card", label: "Credit Card", iconKey: "credit-card" },
    ],
    fulfillmentOptions: [
      {
        id: "home-delivery",
        label: "Door Delivery",
        description: "Standard courier",
        feeMinor: 10000, // 100 ZAR
        etaLabel: "2-4 days",
      },
    ],
  },
  CI: {
    code: "CI",
    name: "Côte d'Ivoire",
    flag: "🇨🇮",
    currency: {
      code: "XOF",
      symbol: "CFA ",
      decimals: 0,
      minorPerMajor: 1, // XOF usually has no minor units
    },
    primaryCity: "Abidjan",
    status: "coming-soon",
    paymentMethods: [
      { id: "orange-money", label: "Orange Money", iconKey: "smartphone" },
    ],
    fulfillmentOptions: [
      {
        id: "home-delivery",
        label: "Livraison à domicile",
        description: "Standard delivery",
        feeMinor: 1500, // 1500 XOF
        etaLabel: "1-3 jours",
      },
    ],
  },
};
