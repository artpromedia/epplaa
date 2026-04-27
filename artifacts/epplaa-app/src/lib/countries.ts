export type CountryCode = "NG" | "GH" | "KE" | "ZA" | "CI";

export interface PaymentMethod {
  id: string;
  label: string;
  iconKey: string;
}

export interface FulfillmentOption {
  id: string;
  label: string;
  description: string;
  feeMinor: number;
  etaLabel: string;
}

export interface Country {
  code: CountryCode;
  name: string;
  flag: string;
  currency: {
    code: string;
    symbol: string;
    decimals: number;
    minorPerMajor: number;
  };
  paymentMethods: PaymentMethod[];
  fulfillmentOptions: FulfillmentOption[];
  primaryCity: string;
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
    status: "live",
    paymentMethods: [
      { id: "mtn-momo", label: "MTN Mobile Money", iconKey: "smartphone" },
      { id: "vodafone-cash", label: "Vodafone Cash", iconKey: "smartphone" },
      { id: "airteltigo-money", label: "AirtelTigo Money", iconKey: "smartphone" },
      { id: "paystack-card-gh", label: "Card via Paystack", iconKey: "credit-card" },
    ],
    fulfillmentOptions: [
      {
        id: "epplaa-box-accra",
        label: "Epplaa Box Locker",
        description: "Free pickup at lockers across Accra.",
        feeMinor: 0,
        etaLabel: "1-2 days",
      },
      {
        id: "speedaf-pickup",
        label: "Speedaf Pickup Point",
        description: "Collect from a verified Speedaf shop.",
        feeMinor: 1500, // GHS 15
        etaLabel: "2-3 days",
      },
      {
        id: "home-delivery-gh",
        label: "Home Delivery",
        description: "Door delivery via Bolt / Yango.",
        feeMinor: 3500, // GHS 35
        etaLabel: "Same day",
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
    status: "live",
    paymentMethods: [
      { id: "mpesa", label: "M-Pesa", iconKey: "smartphone" },
      { id: "airtel-money-ke", label: "Airtel Money", iconKey: "smartphone" },
      { id: "card-ke", label: "Card", iconKey: "credit-card" },
      { id: "cod-ke", label: "Pay on Collection", iconKey: "banknote" },
    ],
    fulfillmentOptions: [
      {
        id: "epplaa-box-nbo",
        label: "Epplaa Box Locker",
        description: "Free pickup near you in Nairobi.",
        feeMinor: 0,
        etaLabel: "1-2 days",
      },
      {
        id: "g4s-pickup",
        label: "G4S Pickup Point",
        description: "Collect from a verified G4S point.",
        feeMinor: 15000, // KES 150
        etaLabel: "1-3 days",
      },
      {
        id: "home-delivery-ke",
        label: "Home Delivery",
        description: "Doorstep delivery via Glovo / Bolt.",
        feeMinor: 35000, // KES 350
        etaLabel: "Same day",
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
    status: "live",
    paymentMethods: [
      { id: "card-za", label: "Card", iconKey: "credit-card" },
      { id: "ozow-eft", label: "Instant EFT (Ozow)", iconKey: "landmark" },
      { id: "snapscan", label: "SnapScan", iconKey: "smartphone" },
      { id: "cod-za", label: "Pay on Collection", iconKey: "banknote" },
    ],
    fulfillmentOptions: [
      {
        id: "pargo-locker",
        label: "Pargo Locker",
        description: "Free pickup from a Pargo locker near you.",
        feeMinor: 0,
        etaLabel: "2-3 days",
      },
      {
        id: "paxi-pickup",
        label: "PEP Paxi Pickup",
        description: "Collect from your nearest PEP store.",
        feeMinor: 5995, // R 59.95
        etaLabel: "3-5 days",
      },
      {
        id: "home-delivery-za",
        label: "Door Delivery",
        description: "Via The Courier Guy / Pick n Pay ASAP.",
        feeMinor: 9900, // R 99
        etaLabel: "1-2 days",
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
      minorPerMajor: 1, // XOF has no minor units
    },
    primaryCity: "Abidjan",
    status: "live",
    paymentMethods: [
      { id: "orange-money", label: "Orange Money", iconKey: "smartphone" },
      { id: "mtn-momo-ci", label: "MTN Mobile Money", iconKey: "smartphone" },
      { id: "wave", label: "Wave", iconKey: "smartphone" },
      { id: "card-ci", label: "Carte Bancaire", iconKey: "credit-card" },
    ],
    fulfillmentOptions: [
      {
        id: "epplaa-box-abj",
        label: "Point Relais Epplaa",
        description: "Retrait gratuit dans un point relais à Abidjan.",
        feeMinor: 0,
        etaLabel: "2-3 jours",
      },
      {
        id: "pickup-ci",
        label: "Point Relais Partenaire",
        description: "Collect from a verified partner shop.",
        feeMinor: 1500, // 1500 XOF
        etaLabel: "2-4 jours",
      },
      {
        id: "home-delivery-ci",
        label: "Livraison à domicile",
        description: "Livraison à domicile via Glovo Abidjan.",
        feeMinor: 3500, // 3500 XOF
        etaLabel: "Même jour",
      },
    ],
  },
};
