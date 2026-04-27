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

export interface IdentityDoc {
  code: string;
  label: string;
  helper: string;
  expectedLength: number;
  kind: "digits" | "alphanumeric";
}

export interface BusinessRegistry {
  shortName: string;
  fullName: string;
  numberLabel: string;
  numberPlaceholder: string;
  numberHelper: string;
}

export interface BankAccountSpec {
  label: string;
  placeholder: string;
  minDigits: number;
  maxDigits: number;
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
  identityDocs: IdentityDoc[];
  businessRegistry: BusinessRegistry;
  bankAccount: BankAccountSpec;
  payoutAuthority: string;
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
    payoutAuthority: "Central Bank of Nigeria",
    identityDocs: [
      { code: "BVN", label: "BVN", helper: "Bank Verification Number", expectedLength: 11, kind: "digits" },
      { code: "NIN", label: "NIN", helper: "National Identification Number", expectedLength: 11, kind: "digits" },
    ],
    businessRegistry: {
      shortName: "CAC",
      fullName: "Corporate Affairs Commission",
      numberLabel: "CAC registration number",
      numberPlaceholder: "RC-1234567",
      numberHelper: "From your CAC certificate (RC- prefix).",
    },
    bankAccount: {
      label: "NUBAN account number",
      placeholder: "10-digit NUBAN",
      minDigits: 10,
      maxDigits: 10,
    },
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
    payoutAuthority: "Bank of Ghana",
    identityDocs: [
      { code: "GHANACARD", label: "Ghana Card", helper: "Format: GHA-XXXXXXXXX-X", expectedLength: 13, kind: "alphanumeric" },
      { code: "VOTER", label: "Voter's ID", helper: "10-digit Voter's ID number", expectedLength: 10, kind: "digits" },
    ],
    businessRegistry: {
      shortName: "RGD",
      fullName: "Registrar General's Department",
      numberLabel: "RGD company number",
      numberPlaceholder: "CS123456789",
      numberHelper: "From your RGD Certificate to Commence Business.",
    },
    bankAccount: {
      label: "Bank account number",
      placeholder: "10-16 digit account number",
      minDigits: 10,
      maxDigits: 16,
    },
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
    payoutAuthority: "Central Bank of Kenya",
    identityDocs: [
      { code: "NATIONAL_ID", label: "National ID", helper: "8-digit Kenyan National ID", expectedLength: 8, kind: "digits" },
      { code: "HUDUMA", label: "Huduma Namba", helper: "9-digit Huduma number", expectedLength: 9, kind: "digits" },
    ],
    businessRegistry: {
      shortName: "BRS",
      fullName: "Business Registration Service",
      numberLabel: "Business Registration Number",
      numberPlaceholder: "BN-AB1234567",
      numberHelper: "From your BRS / eCitizen business certificate.",
    },
    bankAccount: {
      label: "Bank account number",
      placeholder: "10-14 digit account",
      minDigits: 10,
      maxDigits: 14,
    },
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
    payoutAuthority: "South African Reserve Bank",
    identityDocs: [
      { code: "SA_ID", label: "SA ID", helper: "13-digit South African ID", expectedLength: 13, kind: "digits" },
      { code: "PASSPORT_ZA", label: "Passport", helper: "9-character South African passport number", expectedLength: 9, kind: "alphanumeric" },
    ],
    businessRegistry: {
      shortName: "CIPC",
      fullName: "Companies and Intellectual Property Commission",
      numberLabel: "CIPC registration number",
      numberPlaceholder: "2024/123456/07",
      numberHelper: "Format: YYYY/NNNNNN/NN from your CIPC certificate.",
    },
    bankAccount: {
      label: "Bank account number",
      placeholder: "9-11 digit account",
      minDigits: 9,
      maxDigits: 11,
    },
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
    payoutAuthority: "BCEAO (Banque Centrale)",
    identityDocs: [
      { code: "CNI", label: "CNI", helper: "Carte Nationale d'Identité (14 caractères)", expectedLength: 14, kind: "alphanumeric" },
      { code: "PASSPORT_CI", label: "Passeport", helper: "Numéro de passeport (8 caractères)", expectedLength: 8, kind: "alphanumeric" },
    ],
    businessRegistry: {
      shortName: "RCCM",
      fullName: "Registre du Commerce et du Crédit Mobilier (CEPICI)",
      numberLabel: "Numéro RCCM",
      numberPlaceholder: "CI-ABJ-2024-A-12345",
      numberHelper: "Délivré par le CEPICI / Tribunal de commerce.",
    },
    bankAccount: {
      label: "Numéro de compte (RIB)",
      placeholder: "Compte 24 chiffres",
      minDigits: 16,
      maxDigits: 28,
    },
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
