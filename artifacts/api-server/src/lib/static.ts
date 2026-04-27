// Server-side mirror of the country/promo/fulfillment seed data. The frontend
// historically held this data inline; the server now owns it so endpoints can
// validate against the same source of truth.

export interface CountryCurrency {
  code: string;
  symbol: string;
  decimals: number;
  minorPerMajor: number;
}

export interface CountryRow {
  code: string;
  name: string;
  flag: string;
  currency: CountryCurrency;
  primaryCity: string;
  status: "live" | "coming-soon";
  payoutAuthority?: string;
  identityDocs: Array<{ code: string; label: string; helper: string; expectedLength: number; kind: "digits" | "alphanumeric" }>;
  businessRegistry: { shortName: string; fullName: string; numberLabel: string; numberPlaceholder: string; numberHelper: string };
  bankAccount: { label: string; placeholder: string; minDigits: number; maxDigits: number; bankNameExamples: string };
  paymentMethods: Array<{ id: string; label: string; iconKey: string }>;
  fulfillmentOptions: Array<{ id: string; label: string; description: string; feeMinor: number; etaLabel: string }>;
}

const NGN: CountryCurrency = { code: "NGN", symbol: "\u20A6", decimals: 2, minorPerMajor: 100 };
const GHS: CountryCurrency = { code: "GHS", symbol: "GH\u20B5", decimals: 2, minorPerMajor: 100 };
const KES: CountryCurrency = { code: "KES", symbol: "KSh", decimals: 2, minorPerMajor: 100 };
const ZAR: CountryCurrency = { code: "ZAR", symbol: "R", decimals: 2, minorPerMajor: 100 };
const XOF: CountryCurrency = { code: "XOF", symbol: "CFA", decimals: 0, minorPerMajor: 1 };

export const COUNTRIES: CountryRow[] = [
  {
    code: "NG", name: "Nigeria", flag: "\uD83C\uDDF3\uD83C\uDDEC", currency: NGN, primaryCity: "Lagos", status: "live",
    payoutAuthority: "Central Bank of Nigeria",
    identityDocs: [
      { code: "BVN", label: "BVN", helper: "Bank Verification Number", expectedLength: 11, kind: "digits" },
      { code: "NIN", label: "NIN", helper: "National Identification Number", expectedLength: 11, kind: "digits" },
    ],
    businessRegistry: { shortName: "CAC", fullName: "Corporate Affairs Commission", numberLabel: "CAC registration number", numberPlaceholder: "RC-1234567", numberHelper: "From your CAC certificate (RC- prefix)." },
    bankAccount: { label: "NUBAN account number", placeholder: "10-digit NUBAN", minDigits: 10, maxDigits: 10, bankNameExamples: "GTBank, Access, Kuda..." },
    paymentMethods: [
      { id: "paystack-card", label: "Card via Paystack", iconKey: "credit-card" },
      { id: "flutterwave-bank", label: "Bank Transfer", iconKey: "landmark" },
      { id: "ussd", label: "USSD", iconKey: "smartphone" },
      { id: "cod", label: "Pay on Collection", iconKey: "banknote" },
    ],
    fulfillmentOptions: [
      { id: "epplaa-box", label: "Epplaa Box pickup", description: "Free pickup from a 24/7 locker near you.", feeMinor: 0, etaLabel: "Tomorrow" },
      { id: "pudo", label: "Neighbourhood pickup", description: "Collect from a nearby PUDO partner.", feeMinor: 50000, etaLabel: "1-2 days" },
      { id: "door", label: "Door delivery", description: "Rider drops at your door.", feeMinor: 200000, etaLabel: "Same day" },
    ],
  },
  {
    code: "GH", name: "Ghana", flag: "\uD83C\uDDEC\uD83C\uDDED", currency: GHS, primaryCity: "Accra", status: "live",
    payoutAuthority: "Bank of Ghana",
    identityDocs: [{ code: "GHC", label: "Ghana Card", helper: "GHA-prefixed national ID", expectedLength: 15, kind: "alphanumeric" }],
    businessRegistry: { shortName: "RGD", fullName: "Registrar General's Department", numberLabel: "RGD certificate number", numberPlaceholder: "CS123456789", numberHelper: "From your incorporation certificate." },
    bankAccount: { label: "Ghana bank account", placeholder: "13-digit account", minDigits: 10, maxDigits: 16, bankNameExamples: "GCB, Ecobank, Fidelity..." },
    paymentMethods: [
      { id: "mtn-momo", label: "MTN MoMo", iconKey: "smartphone" },
      { id: "vodafone-cash", label: "Vodafone Cash", iconKey: "smartphone" },
      { id: "card-gh", label: "Card", iconKey: "credit-card" },
      { id: "cod", label: "Pay on Collection", iconKey: "banknote" },
    ],
    fulfillmentOptions: [
      { id: "epplaa-box-accra", label: "Epplaa Box pickup", description: "Free pickup at an Accra locker.", feeMinor: 0, etaLabel: "1-2 days" },
      { id: "speedaf-pickup", label: "Speedaf pickup", description: "Collect from any Speedaf branch.", feeMinor: 1500, etaLabel: "2-3 days" },
      { id: "door-gh", label: "Door delivery", description: "Rider drops to your door.", feeMinor: 4000, etaLabel: "Same day" },
    ],
  },
  {
    code: "KE", name: "Kenya", flag: "\uD83C\uDDF0\uD83C\uDDEA", currency: KES, primaryCity: "Nairobi", status: "live",
    payoutAuthority: "Central Bank of Kenya",
    identityDocs: [{ code: "ID", label: "National ID", helper: "Huduma/National ID number", expectedLength: 8, kind: "digits" }],
    businessRegistry: { shortName: "BRS", fullName: "Business Registration Service", numberLabel: "BRS number", numberPlaceholder: "PVT-XXXX", numberHelper: "From your eCitizen BRS profile." },
    bankAccount: { label: "Kenya bank account", placeholder: "Account number", minDigits: 8, maxDigits: 16, bankNameExamples: "Equity, KCB, Co-op..." },
    paymentMethods: [
      { id: "mpesa", label: "M-Pesa", iconKey: "smartphone" },
      { id: "card-ke", label: "Card", iconKey: "credit-card" },
      { id: "airtel-money", label: "Airtel Money", iconKey: "smartphone" },
      { id: "cod", label: "Pay on Collection", iconKey: "banknote" },
    ],
    fulfillmentOptions: [
      { id: "epplaa-box-nbo", label: "Epplaa Box pickup", description: "Free pickup at a Nairobi locker.", feeMinor: 0, etaLabel: "1-2 days" },
      { id: "g4s-pickup", label: "G4S pickup", description: "Collect at any G4S branch.", feeMinor: 15000, etaLabel: "2-3 days" },
      { id: "door-ke", label: "Door delivery", description: "Rider drops to your door.", feeMinor: 30000, etaLabel: "Same day" },
    ],
  },
  {
    code: "ZA", name: "South Africa", flag: "\uD83C\uDDFF\uD83C\uDDE6", currency: ZAR, primaryCity: "Johannesburg", status: "live",
    payoutAuthority: "South African Reserve Bank",
    identityDocs: [{ code: "SAID", label: "SA ID", helper: "13-digit South African ID", expectedLength: 13, kind: "digits" }],
    businessRegistry: { shortName: "CIPC", fullName: "Companies and IP Commission", numberLabel: "CIPC registration", numberPlaceholder: "2024/123456/07", numberHelper: "From your CIPC certificate." },
    bankAccount: { label: "ZA bank account", placeholder: "Account number", minDigits: 9, maxDigits: 11, bankNameExamples: "Standard Bank, FNB, Nedbank..." },
    paymentMethods: [
      { id: "card-za", label: "Card", iconKey: "credit-card" },
      { id: "instant-eft", label: "Instant EFT", iconKey: "landmark" },
      { id: "snapscan", label: "SnapScan", iconKey: "smartphone" },
      { id: "cod", label: "Pay on Collection", iconKey: "banknote" },
    ],
    fulfillmentOptions: [
      { id: "pargo-locker", label: "Pargo Locker", description: "Collect from a 24/7 Pargo locker.", feeMinor: 0, etaLabel: "1-2 days" },
      { id: "paxi-pickup", label: "PEP Paxi", description: "Pick up from any PEP store.", feeMinor: 5000, etaLabel: "2-3 days" },
      { id: "door-za", label: "Door delivery", description: "Courier drops to your door.", feeMinor: 8000, etaLabel: "Same day" },
    ],
  },
  {
    code: "CI", name: "Cote d'Ivoire", flag: "\uD83C\uDDE8\uD83C\uDDEE", currency: XOF, primaryCity: "Abidjan", status: "live",
    payoutAuthority: "BCEAO",
    identityDocs: [{ code: "CNI", label: "CNI", helper: "Carte Nationale d'Identite", expectedLength: 10, kind: "alphanumeric" }],
    businessRegistry: { shortName: "RCCM", fullName: "Registre du Commerce", numberLabel: "RCCM number", numberPlaceholder: "CI-ABJ-2024-A-12345", numberHelper: "From your RCCM extract." },
    bankAccount: { label: "BCEAO bank account", placeholder: "Account number", minDigits: 10, maxDigits: 18, bankNameExamples: "Ecobank, SGCI, NSIA..." },
    paymentMethods: [
      { id: "orange-money", label: "Orange Money", iconKey: "smartphone" },
      { id: "wave", label: "Wave", iconKey: "smartphone" },
      { id: "moov-money", label: "Moov Money", iconKey: "smartphone" },
      { id: "card-ci", label: "Carte", iconKey: "credit-card" },
    ],
    fulfillmentOptions: [
      { id: "epplaa-box-abj", label: "Point Relais Epplaa", description: "Retrait gratuit au point relais.", feeMinor: 0, etaLabel: "1-2 jours" },
      { id: "pickup-ci", label: "Point relais partenaire", description: "Recupere en boutique partenaire.", feeMinor: 500, etaLabel: "2-3 jours" },
      { id: "door-ci", label: "Livraison a domicile", description: "Coursier a domicile.", feeMinor: 1500, etaLabel: "Meme jour" },
    ],
  },
];

export const COUNTRY_BY_CODE: Map<string, CountryRow> = new Map(
  COUNTRIES.map((c) => [c.code, c]),
);

export interface PromoCodeRow {
  code: string;
  label: string;
  kind: "percent" | "fixed_minor" | "free_shipping";
  value: number;
  maxDiscountMajor?: number;
  minSubtotalMajor?: number;
}

export const PROMO_CODES: Record<string, PromoCodeRow> = {
  WELCOME10: { code: "WELCOME10", label: "10% off your order", kind: "percent", value: 10, maxDiscountMajor: 5000 },
  EPPLAA20: { code: "EPPLAA20", label: "20% off (max 10K)", kind: "percent", value: 20, maxDiscountMajor: 10000, minSubtotalMajor: 5000 },
  FIRSTORDER: { code: "FIRSTORDER", label: "Free shipping", kind: "free_shipping", value: 0 },
  LAGOS500: { code: "LAGOS500", label: "500 off", kind: "fixed_minor", value: 500, minSubtotalMajor: 2000 },
};

export const SEED_FULFILLMENT_LOCATIONS = [
  { id: "ng-box-yaba", optionId: "epplaa-box", countryCode: "NG", city: "Lagos", name: "Epplaa Box \u00B7 Yaba", addressLine: "Plot 14, Herbert Macaulay Way, Yaba", hours: "24/7", distanceLabel: "0.8 km", mapX: 35, mapY: 42 },
  { id: "ng-box-surulere", optionId: "epplaa-box", countryCode: "NG", city: "Lagos", name: "Epplaa Box \u00B7 Surulere", addressLine: "Adeniran Ogunsanya Mall, Surulere", hours: "24/7", distanceLabel: "1.2 km", mapX: 32, mapY: 55 },
  { id: "ng-box-lekki1", optionId: "epplaa-box", countryCode: "NG", city: "Lagos", name: "Epplaa Box \u00B7 Lekki Phase 1", addressLine: "Admiralty Way, Lekki Phase 1", hours: "24/7", distanceLabel: "3.4 km", mapX: 65, mapY: 60 },
  { id: "ng-box-vi", optionId: "epplaa-box", countryCode: "NG", city: "Lagos", name: "Epplaa Box \u00B7 Victoria Island", addressLine: "1004 Estate, Victoria Island", hours: "24/7", distanceLabel: "5.1 km", mapX: 55, mapY: 65 },
  { id: "ng-box-ikeja", optionId: "epplaa-box", countryCode: "NG", city: "Lagos", name: "Epplaa Box \u00B7 Ikeja City Mall", addressLine: "Obafemi Awolowo Way, Alausa", hours: "8am - 10pm", distanceLabel: "7.2 km", mapX: 38, mapY: 25 },
  { id: "ng-pudo-mushin", optionId: "pudo", countryCode: "NG", city: "Lagos", name: "Mama T Provisions (PUDO)", addressLine: "23 Olosa St, Mushin", hours: "8am - 8pm", distanceLabel: "2.1 km", mapX: 30, mapY: 35 },
  { id: "ng-pudo-ajah", optionId: "pudo", countryCode: "NG", city: "Lagos", name: "Bayo Mart (PUDO)", addressLine: "Lekki-Epe Expy, Ajah", hours: "7am - 9pm", distanceLabel: "9.5 km", mapX: 80, mapY: 65 },
  { id: "ng-pudo-festac", optionId: "pudo", countryCode: "NG", city: "Lagos", name: "FestyShop (PUDO)", addressLine: "4th Ave, Festac Town", hours: "9am - 7pm", distanceLabel: "12.3 km", mapX: 18, mapY: 65 },
  { id: "ng-pudo-gbagada", optionId: "pudo", countryCode: "NG", city: "Lagos", name: "Chika & Sons (PUDO)", addressLine: "Diya St, Gbagada Phase 2", hours: "8am - 9pm", distanceLabel: "4.8 km", mapX: 48, mapY: 35 },
  { id: "ng-pudo-ikoyi", optionId: "pudo", countryCode: "NG", city: "Lagos", name: "Ikoyi Express (PUDO)", addressLine: "Awolowo Rd, Ikoyi", hours: "8am - 8pm", distanceLabel: "6.0 km", mapX: 50, mapY: 60 },
  { id: "ng-box-wuse2", optionId: "epplaa-box", countryCode: "NG", city: "Abuja", name: "Epplaa Box \u00B7 Wuse 2", addressLine: "Aminu Kano Cres, Wuse 2", hours: "24/7", distanceLabel: "1.5 km", mapX: 45, mapY: 40 },
  { id: "ng-box-maitama", optionId: "epplaa-box", countryCode: "NG", city: "Abuja", name: "Epplaa Box \u00B7 Maitama", addressLine: "Aguiyi Ironsi St, Maitama", hours: "24/7", distanceLabel: "3.1 km", mapX: 50, mapY: 30 },
  { id: "ng-box-garki", optionId: "epplaa-box", countryCode: "NG", city: "Abuja", name: "Epplaa Box \u00B7 Garki II", addressLine: "Gimbiya St, Garki II", hours: "24/7", distanceLabel: "2.4 km", mapX: 48, mapY: 55 },
  { id: "ng-pudo-jabi", optionId: "pudo", countryCode: "NG", city: "Abuja", name: "Jabi Lake Mall (PUDO)", addressLine: "Bala Sokoto Way, Jabi", hours: "9am - 9pm", distanceLabel: "5.6 km", mapX: 35, mapY: 35 },
  { id: "ng-pudo-asokoro", optionId: "pudo", countryCode: "NG", city: "Abuja", name: "Asokoro Quick Stop (PUDO)", addressLine: "Yedseram St, Asokoro", hours: "8am - 8pm", distanceLabel: "4.2 km", mapX: 60, mapY: 50 },
  { id: "gh-box-osu", optionId: "epplaa-box-accra", countryCode: "GH", city: "Accra", name: "Epplaa Box \u00B7 Osu", addressLine: "Oxford St, Osu", hours: "24/7", distanceLabel: "1.0 km", mapX: 50, mapY: 55 },
  { id: "gh-box-east-legon", optionId: "epplaa-box-accra", countryCode: "GH", city: "Accra", name: "Epplaa Box \u00B7 East Legon", addressLine: "Lagos Ave, East Legon", hours: "24/7", distanceLabel: "4.5 km", mapX: 65, mapY: 35 },
  { id: "gh-box-airport", optionId: "epplaa-box-accra", countryCode: "GH", city: "Accra", name: "Epplaa Box \u00B7 Airport City", addressLine: "Airport City, Accra", hours: "24/7", distanceLabel: "6.2 km", mapX: 55, mapY: 30 },
  { id: "gh-pudo-mada", optionId: "speedaf-pickup", countryCode: "GH", city: "Accra", name: "Speedaf \u00B7 Madina", addressLine: "Madina Old Road", hours: "8am - 8pm", distanceLabel: "9.8 km", mapX: 70, mapY: 25 },
  { id: "gh-pudo-circle", optionId: "speedaf-pickup", countryCode: "GH", city: "Accra", name: "Speedaf \u00B7 Circle", addressLine: "Kwame Nkrumah Circle", hours: "7am - 9pm", distanceLabel: "3.1 km", mapX: 40, mapY: 50 },
  { id: "ke-box-westlands", optionId: "epplaa-box-nbo", countryCode: "KE", city: "Nairobi", name: "Epplaa Box \u00B7 Westlands", addressLine: "Westlands Square, Westlands", hours: "24/7", distanceLabel: "1.2 km", mapX: 35, mapY: 40 },
  { id: "ke-box-kileleshwa", optionId: "epplaa-box-nbo", countryCode: "KE", city: "Nairobi", name: "Epplaa Box \u00B7 Kileleshwa", addressLine: "Ring Rd, Kileleshwa", hours: "24/7", distanceLabel: "3.0 km", mapX: 45, mapY: 50 },
  { id: "ke-box-cbd", optionId: "epplaa-box-nbo", countryCode: "KE", city: "Nairobi", name: "Epplaa Box \u00B7 CBD", addressLine: "Tom Mboya St, CBD", hours: "24/7", distanceLabel: "4.5 km", mapX: 50, mapY: 60 },
  { id: "ke-pudo-karen", optionId: "g4s-pickup", countryCode: "KE", city: "Nairobi", name: "G4S \u00B7 Karen", addressLine: "Karen Shopping Centre", hours: "8am - 8pm", distanceLabel: "11.0 km", mapX: 25, mapY: 75 },
  { id: "ke-pudo-thika", optionId: "g4s-pickup", countryCode: "KE", city: "Nairobi", name: "G4S \u00B7 Thika Rd Mall", addressLine: "Thika Superhighway", hours: "9am - 9pm", distanceLabel: "12.5 km", mapX: 70, mapY: 30 },
  { id: "za-box-sandton", optionId: "pargo-locker", countryCode: "ZA", city: "Johannesburg", name: "Pargo Locker \u00B7 Sandton City", addressLine: "Sandton City Mall, Sandton", hours: "24/7", distanceLabel: "1.5 km", mapX: 50, mapY: 35 },
  { id: "za-box-rosebank", optionId: "pargo-locker", countryCode: "ZA", city: "Johannesburg", name: "Pargo Locker \u00B7 Rosebank Mall", addressLine: "Rosebank Mall, Rosebank", hours: "24/7", distanceLabel: "3.0 km", mapX: 45, mapY: 45 },
  { id: "za-box-melrose", optionId: "pargo-locker", countryCode: "ZA", city: "Johannesburg", name: "Pargo Locker \u00B7 Melrose Arch", addressLine: "Melrose Arch Square", hours: "24/7", distanceLabel: "4.2 km", mapX: 55, mapY: 50 },
  { id: "za-pudo-soweto", optionId: "paxi-pickup", countryCode: "ZA", city: "Johannesburg", name: "PEP Paxi \u00B7 Maponya Mall", addressLine: "Maponya Mall, Soweto", hours: "8am - 7pm", distanceLabel: "18.0 km", mapX: 25, mapY: 70 },
  { id: "za-pudo-randburg", optionId: "paxi-pickup", countryCode: "ZA", city: "Johannesburg", name: "PEP Paxi \u00B7 Randburg", addressLine: "Cresta Shopping Centre", hours: "8am - 8pm", distanceLabel: "8.5 km", mapX: 30, mapY: 25 },
  { id: "ci-box-cocody", optionId: "epplaa-box-abj", countryCode: "CI", city: "Abidjan", name: "Point Relais Epplaa \u00B7 Cocody", addressLine: "Bd Latrille, Cocody", hours: "24/7", distanceLabel: "1.3 km", mapX: 55, mapY: 35 },
  { id: "ci-box-plateau", optionId: "epplaa-box-abj", countryCode: "CI", city: "Abidjan", name: "Point Relais Epplaa \u00B7 Plateau", addressLine: "Av. Chardy, Plateau", hours: "24/7", distanceLabel: "2.8 km", mapX: 50, mapY: 50 },
  { id: "ci-box-marcory", optionId: "epplaa-box-abj", countryCode: "CI", city: "Abidjan", name: "Point Relais Epplaa \u00B7 Marcory", addressLine: "Bd VGE, Marcory", hours: "24/7", distanceLabel: "5.5 km", mapX: 45, mapY: 65 },
  { id: "ci-pudo-yopougon", optionId: "pickup-ci", countryCode: "CI", city: "Abidjan", name: "Point Relais \u00B7 Yopougon", addressLine: "Yopougon Andokoi", hours: "8am - 8pm", distanceLabel: "12.0 km", mapX: 25, mapY: 50 },
  { id: "ci-pudo-treichville", optionId: "pickup-ci", countryCode: "CI", city: "Abidjan", name: "Point Relais \u00B7 Treichville", addressLine: "Av 16, Treichville", hours: "9am - 9pm", distanceLabel: "4.0 km", mapX: 50, mapY: 60 },
];
