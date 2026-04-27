export type CountryCode =
  // Live + Sprint-1 markets
  | "NG"
  | "GH"
  | "KE"
  | "ZA"
  | "CI"
  // Coming-soon roadmap (West / Central Africa)
  | "SN"
  | "CM"
  | "CD"
  // Coming-soon roadmap (East Africa)
  | "UG"
  | "TZ"
  | "RW"
  | "ET"
  // Coming-soon roadmap (Southern Africa)
  | "BW"
  | "ZM"
  // Coming-soon roadmap (North Africa)
  | "EG"
  | "MA";

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
  /** Comma-separated example bank names shown as the bank-name input placeholder. */
  bankNameExamples: string;
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
      bankNameExamples: "GTBank, Access, Kuda...",
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
      bankNameExamples: "GCB, Ecobank, Stanbic...",
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
      bankNameExamples: "KCB, Equity, NCBA...",
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
      bankNameExamples: "FNB, Standard Bank, Capitec...",
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
      bankNameExamples: "Ecobank, SGBCI, Société Générale...",
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

  // ===========================================================================
  // COMING-SOON ROADMAP — West / Central Africa
  // ===========================================================================
  SN: {
    code: "SN",
    name: "Senegal",
    flag: "🇸🇳",
    currency: { code: "XOF", symbol: "CFA ", decimals: 0, minorPerMajor: 1 },
    primaryCity: "Dakar",
    status: "live",
    payoutAuthority: "BCEAO (Banque Centrale)",
    identityDocs: [
      { code: "CNI_SN", label: "CNI", helper: "Carte Nationale d'Identité (13 chiffres)", expectedLength: 13, kind: "digits" },
      { code: "PASSPORT_SN", label: "Passeport", helper: "Numéro de passeport sénégalais (8 caractères)", expectedLength: 8, kind: "alphanumeric" },
    ],
    businessRegistry: {
      shortName: "RCCM (APIX)",
      fullName: "Registre du Commerce et du Crédit Mobilier (via APIX)",
      numberLabel: "Numéro RCCM",
      numberPlaceholder: "SN-DKR-2024-A-12345",
      numberHelper: "Délivré par l'APIX / Tribunal de commerce de Dakar.",
    },
    bankAccount: { label: "Numéro de compte (RIB)", placeholder: "Compte 24 chiffres", minDigits: 16, maxDigits: 28, bankNameExamples: "CBAO, SGBS, Ecobank..." },
    paymentMethods: [
      { id: "wave-sn", label: "Wave", iconKey: "smartphone" },
      { id: "orange-money-sn", label: "Orange Money", iconKey: "smartphone" },
      { id: "free-money-sn", label: "Free Money", iconKey: "smartphone" },
      { id: "card-sn", label: "Carte Bancaire", iconKey: "credit-card" },
    ],
    fulfillmentOptions: [
      { id: "epplaa-box-dkr", label: "Point Relais Epplaa", description: "Retrait gratuit dans un point relais à Dakar.", feeMinor: 0, etaLabel: "2-3 jours" },
      { id: "pickup-sn", label: "Point Relais Partenaire", description: "Collecte chez un commerçant partenaire vérifié.", feeMinor: 1500, etaLabel: "2-4 jours" },
      { id: "home-delivery-sn", label: "Livraison à domicile", description: "Livraison à domicile via Yango / Heetch.", feeMinor: 3000, etaLabel: "Même jour" },
    ],
  },

  CM: {
    code: "CM",
    name: "Cameroon",
    flag: "🇨🇲",
    currency: { code: "XAF", symbol: "FCFA ", decimals: 0, minorPerMajor: 1 },
    primaryCity: "Douala",
    status: "live",
    payoutAuthority: "BEAC (Banque des États de l'Afrique Centrale)",
    identityDocs: [
      { code: "CNI_CM", label: "CNI", helper: "Carte Nationale d'Identité (9 chiffres)", expectedLength: 9, kind: "digits" },
      { code: "PASSPORT_CM", label: "Passeport", helper: "Numéro de passeport camerounais (8 caractères)", expectedLength: 8, kind: "alphanumeric" },
    ],
    businessRegistry: {
      shortName: "RCCM",
      fullName: "Registre du Commerce et du Crédit Mobilier",
      numberLabel: "Numéro RCCM",
      numberPlaceholder: "RC/DLA/2024/B/1234",
      numberHelper: "Délivré par le Tribunal de commerce / Centre de Formalités.",
    },
    bankAccount: { label: "Numéro de compte (RIB)", placeholder: "Compte 23 chiffres", minDigits: 16, maxDigits: 28, bankNameExamples: "Afriland, BICEC, UBA..." },
    paymentMethods: [
      { id: "orange-money-cm", label: "Orange Money", iconKey: "smartphone" },
      { id: "mtn-momo-cm", label: "MTN Mobile Money", iconKey: "smartphone" },
      { id: "express-union-cm", label: "Express Union Mobile", iconKey: "smartphone" },
      { id: "card-cm", label: "Carte Bancaire", iconKey: "credit-card" },
    ],
    fulfillmentOptions: [
      { id: "epplaa-box-dla", label: "Point Relais Epplaa", description: "Retrait gratuit à Douala et Yaoundé.", feeMinor: 0, etaLabel: "2-3 jours" },
      { id: "pickup-cm", label: "Point Relais Partenaire", description: "Collecte chez un commerçant partenaire.", feeMinor: 1500, etaLabel: "2-4 jours" },
      { id: "home-delivery-cm", label: "Livraison à domicile", description: "Livraison à domicile via Yango Cameroun.", feeMinor: 3500, etaLabel: "Même jour" },
    ],
  },

  CD: {
    code: "CD",
    name: "DR Congo",
    flag: "🇨🇩",
    currency: { code: "CDF", symbol: "FC ", decimals: 0, minorPerMajor: 1 },
    primaryCity: "Kinshasa",
    status: "live",
    payoutAuthority: "Banque Centrale du Congo",
    identityDocs: [
      { code: "CENI_CD", label: "Carte d'électeur", helper: "Numéro de la carte d'électeur CENI", expectedLength: 18, kind: "alphanumeric" },
      { code: "PASSPORT_CD", label: "Passeport", helper: "Numéro de passeport (8 caractères)", expectedLength: 8, kind: "alphanumeric" },
    ],
    businessRegistry: {
      shortName: "RCCM (Guichet Unique)",
      fullName: "Registre du Commerce et du Crédit Mobilier (via Guichet Unique)",
      numberLabel: "Numéro RCCM",
      numberPlaceholder: "CD/KIN/RCCM/24-A-12345",
      numberHelper: "Délivré par le Guichet Unique de Création d'Entreprise.",
    },
    bankAccount: { label: "Numéro de compte", placeholder: "Compte 16-22 chiffres", minDigits: 16, maxDigits: 22, bankNameExamples: "Rawbank, Equity BCDC, TMB..." },
    paymentMethods: [
      { id: "orange-money-cd", label: "Orange Money", iconKey: "smartphone" },
      { id: "airtel-money-cd", label: "Airtel Money", iconKey: "smartphone" },
      { id: "mpesa-cd", label: "M-Pesa (Vodacom)", iconKey: "smartphone" },
      { id: "card-cd", label: "Carte Bancaire", iconKey: "credit-card" },
    ],
    fulfillmentOptions: [
      { id: "epplaa-box-kin", label: "Point Relais Epplaa", description: "Retrait gratuit dans un point relais à Kinshasa.", feeMinor: 0, etaLabel: "2-4 jours" },
      { id: "pickup-cd", label: "Point Relais Partenaire", description: "Collecte chez un commerçant partenaire.", feeMinor: 2500, etaLabel: "3-5 jours" },
      { id: "home-delivery-cd", label: "Livraison à domicile", description: "Livraison à domicile via partenaire local.", feeMinor: 5000, etaLabel: "1-2 jours" },
    ],
  },

  // ===========================================================================
  // COMING-SOON ROADMAP — East Africa
  // ===========================================================================
  UG: {
    code: "UG",
    name: "Uganda",
    flag: "🇺🇬",
    currency: { code: "UGX", symbol: "USh ", decimals: 0, minorPerMajor: 1 },
    primaryCity: "Kampala",
    status: "live",
    payoutAuthority: "Bank of Uganda",
    identityDocs: [
      { code: "NIN_UG", label: "NIN", helper: "National Identification Number (14 characters)", expectedLength: 14, kind: "alphanumeric" },
      { code: "PASSPORT_UG", label: "Passport", helper: "Ugandan passport number (9 characters)", expectedLength: 9, kind: "alphanumeric" },
    ],
    businessRegistry: {
      shortName: "URSB",
      fullName: "Uganda Registration Services Bureau",
      numberLabel: "URSB company number",
      numberPlaceholder: "80020001234567",
      numberHelper: "From your URSB Certificate of Incorporation.",
    },
    bankAccount: { label: "Bank account number", placeholder: "10-14 digit account", minDigits: 10, maxDigits: 14, bankNameExamples: "Stanbic, Centenary, DFCU..." },
    paymentMethods: [
      { id: "mtn-momo-ug", label: "MTN Mobile Money", iconKey: "smartphone" },
      { id: "airtel-money-ug", label: "Airtel Money", iconKey: "smartphone" },
      { id: "card-ug", label: "Card", iconKey: "credit-card" },
      { id: "cod-ug", label: "Pay on Collection", iconKey: "banknote" },
    ],
    fulfillmentOptions: [
      { id: "epplaa-box-kla", label: "Epplaa Box Locker", description: "Free pickup at lockers across Kampala.", feeMinor: 0, etaLabel: "1-2 days" },
      { id: "pickup-ug", label: "Pickup Partner", description: "Collect from a verified local shop.", feeMinor: 5000, etaLabel: "2-3 days" },
      { id: "home-delivery-ug", label: "Home Delivery", description: "Doorstep delivery via SafeBoda / Glovo.", feeMinor: 10000, etaLabel: "Same day" },
    ],
  },

  TZ: {
    code: "TZ",
    name: "Tanzania",
    flag: "🇹🇿",
    currency: { code: "TZS", symbol: "TSh ", decimals: 0, minorPerMajor: 1 },
    primaryCity: "Dar es Salaam",
    status: "live",
    payoutAuthority: "Bank of Tanzania",
    identityDocs: [
      { code: "NIDA_TZ", label: "NIDA ID", helper: "National Identification Authority number (20 digits)", expectedLength: 20, kind: "digits" },
      { code: "PASSPORT_TZ", label: "Passport", helper: "Tanzanian passport number (9 characters)", expectedLength: 9, kind: "alphanumeric" },
    ],
    businessRegistry: {
      shortName: "BRELA",
      fullName: "Business Registrations and Licensing Agency",
      numberLabel: "BRELA company number",
      numberPlaceholder: "139123456",
      numberHelper: "From your BRELA Certificate of Incorporation.",
    },
    bankAccount: { label: "Bank account number", placeholder: "10-16 digit account", minDigits: 10, maxDigits: 16, bankNameExamples: "CRDB, NMB, NBC..." },
    paymentMethods: [
      { id: "mpesa-tz", label: "M-Pesa (Vodacom)", iconKey: "smartphone" },
      { id: "tigo-pesa", label: "Mixx by Yas (Tigo Pesa)", iconKey: "smartphone" },
      { id: "airtel-money-tz", label: "Airtel Money", iconKey: "smartphone" },
      { id: "card-tz", label: "Card", iconKey: "credit-card" },
    ],
    fulfillmentOptions: [
      { id: "epplaa-box-dar", label: "Epplaa Box Locker", description: "Free pickup near you in Dar es Salaam.", feeMinor: 0, etaLabel: "1-2 days" },
      { id: "pickup-tz", label: "Pickup Partner", description: "Collect from a verified Speedaf / local shop.", feeMinor: 3000, etaLabel: "2-3 days" },
      { id: "home-delivery-tz", label: "Home Delivery", description: "Doorstep delivery via Bolt / Yango.", feeMinor: 6000, etaLabel: "Same day" },
    ],
  },

  RW: {
    code: "RW",
    name: "Rwanda",
    flag: "🇷🇼",
    currency: { code: "RWF", symbol: "RF ", decimals: 0, minorPerMajor: 1 },
    primaryCity: "Kigali",
    status: "live",
    payoutAuthority: "National Bank of Rwanda (BNR)",
    identityDocs: [
      { code: "NID_RW", label: "National ID", helper: "Rwandan National ID (16 digits)", expectedLength: 16, kind: "digits" },
      { code: "PASSPORT_RW", label: "Passport", helper: "Rwandan passport number (8 characters)", expectedLength: 8, kind: "alphanumeric" },
    ],
    businessRegistry: {
      shortName: "RDB",
      fullName: "Rwanda Development Board",
      numberLabel: "RDB company code",
      numberPlaceholder: "100123456",
      numberHelper: "From your RDB Certificate of Incorporation (Domestic Registration).",
    },
    bankAccount: { label: "Bank account number", placeholder: "16-20 digit account", minDigits: 16, maxDigits: 20, bankNameExamples: "Bank of Kigali, Equity, I&M..." },
    paymentMethods: [
      { id: "mtn-momo-rw", label: "MTN Mobile Money", iconKey: "smartphone" },
      { id: "airtel-money-rw", label: "Airtel Money", iconKey: "smartphone" },
      { id: "card-rw", label: "Card", iconKey: "credit-card" },
      { id: "cod-rw", label: "Pay on Collection", iconKey: "banknote" },
    ],
    fulfillmentOptions: [
      { id: "epplaa-box-kgl", label: "Epplaa Box Locker", description: "Free pickup at lockers across Kigali.", feeMinor: 0, etaLabel: "1-2 days" },
      { id: "pickup-rw", label: "Pickup Partner", description: "Collect from a verified local shop.", feeMinor: 1000, etaLabel: "1-3 days" },
      { id: "home-delivery-rw", label: "Home Delivery", description: "Doorstep delivery via Move / Yego Moto.", feeMinor: 2500, etaLabel: "Same day" },
    ],
  },

  ET: {
    code: "ET",
    name: "Ethiopia",
    flag: "🇪🇹",
    currency: { code: "ETB", symbol: "Br ", decimals: 2, minorPerMajor: 100 },
    primaryCity: "Addis Ababa",
    status: "live",
    payoutAuthority: "National Bank of Ethiopia",
    identityDocs: [
      { code: "FAYDA_ET", label: "Fayda", helper: "Ethiopian National Digital ID (12 digits)", expectedLength: 12, kind: "digits" },
      { code: "PASSPORT_ET", label: "Passport", helper: "Ethiopian passport number (9 characters)", expectedLength: 9, kind: "alphanumeric" },
    ],
    businessRegistry: {
      shortName: "MoTRI",
      fullName: "Ministry of Trade & Regional Integration",
      numberLabel: "Commercial Registration No.",
      numberPlaceholder: "AA/14/12345/24",
      numberHelper: "From your MoTRI Commercial Registration Certificate.",
    },
    bankAccount: { label: "Bank account number", placeholder: "10-16 digit account", minDigits: 10, maxDigits: 16, bankNameExamples: "CBE, Awash, Dashen..." },
    paymentMethods: [
      { id: "telebirr", label: "telebirr", iconKey: "smartphone" },
      { id: "cbe-birr", label: "CBE Birr", iconKey: "smartphone" },
      { id: "mpesa-et", label: "M-Pesa (Safaricom Ethiopia)", iconKey: "smartphone" },
      { id: "card-et", label: "Card", iconKey: "credit-card" },
      { id: "cod-et", label: "Pay on Collection", iconKey: "banknote" },
    ],
    fulfillmentOptions: [
      { id: "epplaa-box-add", label: "Epplaa Pickup Hub", description: "Free pickup at hubs across Addis Ababa.", feeMinor: 0, etaLabel: "2-3 days" },
      { id: "pickup-et", label: "Partner Pickup Point", description: "Collect from a verified partner shop.", feeMinor: 5000, etaLabel: "2-4 days" },
      { id: "home-delivery-et", label: "Home Delivery", description: "Doorstep delivery via ZayRide / Deliver Addis.", feeMinor: 12000, etaLabel: "Same day" },
    ],
  },

  // ===========================================================================
  // COMING-SOON ROADMAP — Southern Africa
  // ===========================================================================
  BW: {
    code: "BW",
    name: "Botswana",
    flag: "🇧🇼",
    currency: { code: "BWP", symbol: "P ", decimals: 2, minorPerMajor: 100 },
    primaryCity: "Gaborone",
    status: "live",
    payoutAuthority: "Bank of Botswana",
    identityDocs: [
      { code: "OMANG", label: "Omang", helper: "Botswana National ID (9 digits)", expectedLength: 9, kind: "digits" },
      { code: "PASSPORT_BW", label: "Passport", helper: "Botswana passport number (8 characters)", expectedLength: 8, kind: "alphanumeric" },
    ],
    businessRegistry: {
      shortName: "CIPA",
      fullName: "Companies and Intellectual Property Authority",
      numberLabel: "CIPA company number",
      numberPlaceholder: "BW00001234567",
      numberHelper: "From your CIPA Certificate of Incorporation.",
    },
    bankAccount: { label: "Bank account number", placeholder: "10-14 digit account", minDigits: 10, maxDigits: 14, bankNameExamples: "FNB, Stanbic, ABSA..." },
    paymentMethods: [
      { id: "orange-money-bw", label: "Orange Money", iconKey: "smartphone" },
      { id: "myzaka-bw", label: "MyZaka (Mascom)", iconKey: "smartphone" },
      { id: "smega-bw", label: "Smega (BTC Mobile)", iconKey: "smartphone" },
      { id: "card-bw", label: "Card", iconKey: "credit-card" },
      { id: "eft-bw", label: "EFT", iconKey: "landmark" },
    ],
    fulfillmentOptions: [
      { id: "epplaa-box-gbe", label: "Epplaa Pickup Point", description: "Free pickup at Gaborone partner hubs.", feeMinor: 0, etaLabel: "2-3 days" },
      { id: "pickup-bw", label: "Pickup Partner", description: "Collect from a verified Choppies / partner store.", feeMinor: 3500, etaLabel: "2-4 days" },
      { id: "home-delivery-bw", label: "Home Delivery", description: "Doorstep delivery via local courier.", feeMinor: 7500, etaLabel: "1-2 days" },
    ],
  },

  ZM: {
    code: "ZM",
    name: "Zambia",
    flag: "🇿🇲",
    currency: { code: "ZMW", symbol: "K ", decimals: 2, minorPerMajor: 100 },
    primaryCity: "Lusaka",
    status: "live",
    payoutAuthority: "Bank of Zambia",
    identityDocs: [
      { code: "NRC_ZM", label: "NRC", helper: "National Registration Card (e.g. 123456/78/9)", expectedLength: 11, kind: "alphanumeric" },
      { code: "PASSPORT_ZM", label: "Passport", helper: "Zambian passport number (9 characters)", expectedLength: 9, kind: "alphanumeric" },
    ],
    businessRegistry: {
      shortName: "PACRA",
      fullName: "Patents and Companies Registration Agency",
      numberLabel: "PACRA company number",
      numberPlaceholder: "120240001234",
      numberHelper: "From your PACRA Certificate of Incorporation.",
    },
    bankAccount: { label: "Bank account number", placeholder: "10-13 digit account", minDigits: 10, maxDigits: 13, bankNameExamples: "Zanaco, Stanbic, FNB..." },
    paymentMethods: [
      { id: "airtel-money-zm", label: "Airtel Money", iconKey: "smartphone" },
      { id: "mtn-momo-zm", label: "MTN Mobile Money", iconKey: "smartphone" },
      { id: "zamtel-kwacha", label: "Zamtel Kwacha", iconKey: "smartphone" },
      { id: "card-zm", label: "Card", iconKey: "credit-card" },
    ],
    fulfillmentOptions: [
      { id: "epplaa-box-lun", label: "Epplaa Pickup Point", description: "Free pickup at Lusaka partner hubs.", feeMinor: 0, etaLabel: "2-3 days" },
      { id: "pickup-zm", label: "Pickup Partner", description: "Collect from a verified Shoprite / partner shop.", feeMinor: 3500, etaLabel: "2-4 days" },
      { id: "home-delivery-zm", label: "Home Delivery", description: "Doorstep delivery via Yango / Ulendo.", feeMinor: 7500, etaLabel: "Same day" },
    ],
  },

  // ===========================================================================
  // COMING-SOON ROADMAP — North Africa
  // ===========================================================================
  EG: {
    code: "EG",
    name: "Egypt",
    flag: "🇪🇬",
    currency: { code: "EGP", symbol: "E£ ", decimals: 2, minorPerMajor: 100 },
    primaryCity: "Cairo",
    status: "live",
    payoutAuthority: "Central Bank of Egypt",
    identityDocs: [
      { code: "NID_EG", label: "National ID", helper: "Egyptian National ID (14 digits)", expectedLength: 14, kind: "digits" },
      { code: "PASSPORT_EG", label: "Passport", helper: "Egyptian passport number (9 characters)", expectedLength: 9, kind: "alphanumeric" },
    ],
    businessRegistry: {
      shortName: "GAFI",
      fullName: "General Authority for Investment & Free Zones",
      numberLabel: "Commercial Registration No.",
      numberPlaceholder: "123456",
      numberHelper: "From your GAFI commercial registry certificate.",
    },
    bankAccount: { label: "Bank account number", placeholder: "10-16 digit account", minDigits: 10, maxDigits: 16, bankNameExamples: "NBE, CIB, QNB Alahli..." },
    paymentMethods: [
      { id: "card-eg", label: "Card", iconKey: "credit-card" },
      { id: "fawry", label: "Fawry", iconKey: "smartphone" },
      { id: "vodafone-cash-eg", label: "Vodafone Cash", iconKey: "smartphone" },
      { id: "instapay-eg", label: "InstaPay", iconKey: "landmark" },
      { id: "cod-eg", label: "Cash on Delivery", iconKey: "banknote" },
    ],
    fulfillmentOptions: [
      { id: "epplaa-box-cai", label: "Epplaa Pickup Point", description: "Free pickup at hubs across Greater Cairo.", feeMinor: 0, etaLabel: "1-3 days" },
      { id: "pickup-eg", label: "Pickup Partner", description: "Collect from a verified Aramex / Bosta point.", feeMinor: 3500, etaLabel: "2-3 days" },
      { id: "home-delivery-eg", label: "Home Delivery", description: "Doorstep delivery via Mylerz / Bosta.", feeMinor: 7500, etaLabel: "1-2 days" },
    ],
  },

  MA: {
    code: "MA",
    name: "Morocco",
    flag: "🇲🇦",
    currency: { code: "MAD", symbol: "DH ", decimals: 2, minorPerMajor: 100 },
    primaryCity: "Casablanca",
    status: "live",
    payoutAuthority: "Bank Al-Maghrib",
    identityDocs: [
      { code: "CNIE_MA", label: "CNIE", helper: "Carte Nationale d'Identité Électronique (8 caractères)", expectedLength: 8, kind: "alphanumeric" },
      { code: "PASSPORT_MA", label: "Passeport", helper: "Numéro de passeport marocain (8 caractères)", expectedLength: 8, kind: "alphanumeric" },
    ],
    businessRegistry: {
      shortName: "RC (OMPIC)",
      fullName: "Registre du Commerce (via OMPIC)",
      numberLabel: "Numéro RC",
      numberPlaceholder: "RC-CASA-123456",
      numberHelper: "Délivré par l'OMPIC / Tribunal de commerce.",
    },
    bankAccount: { label: "Numéro de compte (RIB)", placeholder: "RIB 24 chiffres", minDigits: 16, maxDigits: 28, bankNameExamples: "Attijariwafa, BMCE, BCP..." },
    paymentMethods: [
      { id: "card-ma", label: "Carte Bancaire (CMI)", iconKey: "credit-card" },
      { id: "m-wallet-ma", label: "M-Wallet", iconKey: "smartphone" },
      { id: "cash-plus-ma", label: "Cash Plus", iconKey: "landmark" },
      { id: "inwi-money", label: "Inwi Money", iconKey: "smartphone" },
      { id: "cod-ma", label: "Paiement à la livraison", iconKey: "banknote" },
    ],
    fulfillmentOptions: [
      { id: "epplaa-box-cas", label: "Point Relais Epplaa", description: "Retrait gratuit à Casablanca et Rabat.", feeMinor: 0, etaLabel: "2-3 jours" },
      { id: "pickup-ma", label: "Point Relais Partenaire", description: "Collecte chez un partenaire Amana / Chronopost.", feeMinor: 1500, etaLabel: "2-4 jours" },
      { id: "home-delivery-ma", label: "Livraison à domicile", description: "Livraison à domicile via Glovo / Yango.", feeMinor: 3500, etaLabel: "Même jour" },
    ],
  },
};
