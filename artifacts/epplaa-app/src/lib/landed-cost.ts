// Landed cost & customs status helpers for cross-border items. Frontend-only
// approximation of what production would calculate via a tariff API + freight
// quote service. The numbers below are illustrative percentages tuned to feel
// realistic for the West-Africa import lane.

import { CountryCode } from "./countries";

export type ShipMode = "air" | "sea";

export interface LandedCostInput {
  productPriceMinor: number;
  originCountry: string; // e.g. "China", "Nigeria"
  destinationCode: CountryCode;
  shipMode?: ShipMode;
}

export interface LandedCostBreakdown {
  isImport: boolean;
  fobMinor: number;
  freightMinor: number;
  insuranceMinor: number;
  dutyMinor: number;
  vatMinor: number;
  clearanceMinor: number;
  totalMinor: number;
  shipMode: ShipMode;
  etaLabel: string;
  originCountry: string;
}

const DUTY_RATES: Record<string, number> = {
  // Default duty rate for general consumer goods entering an African market.
  default: 0.2,
  Beauty: 0.1,
  Phones: 0.05,
  Fashion: 0.2,
  Home: 0.15,
};

const FREIGHT_FACTOR: Record<ShipMode, number> = {
  air: 0.18, // 18% of FOB for express air freight
  sea: 0.06, // 6% of FOB for sea freight (slower)
};

const ETA: Record<ShipMode, string> = {
  air: "5 to 9 days door to door",
  sea: "21 to 35 days door to port",
};

const NON_IMPORT_ORIGINS = new Set([
  "Nigeria",
  "Ghana",
  "Kenya",
  "South Africa",
  "Cote d'Ivoire",
  "Egypt",
  "Morocco",
  "Tanzania",
  "Uganda",
  "Rwanda",
  "Ethiopia",
  "Senegal",
  "Cameroon",
  "Botswana",
  "Zambia",
  "DR Congo",
]);

export function isImport(originCountry: string): boolean {
  return !NON_IMPORT_ORIGINS.has(originCountry);
}

export function computeLandedCost(
  input: LandedCostInput,
  category = "default",
): LandedCostBreakdown {
  const fobMinor = input.productPriceMinor;
  const importing = isImport(input.originCountry);
  const shipMode: ShipMode = input.shipMode ?? "air";

  if (!importing) {
    return {
      isImport: false,
      fobMinor,
      freightMinor: 0,
      insuranceMinor: 0,
      dutyMinor: 0,
      vatMinor: 0,
      clearanceMinor: 0,
      totalMinor: fobMinor,
      shipMode,
      etaLabel: "Local delivery",
      originCountry: input.originCountry,
    };
  }

  const freightMinor = Math.round(fobMinor * FREIGHT_FACTOR[shipMode]);
  const insuranceMinor = Math.round(fobMinor * 0.01);
  const dutiableBase = fobMinor + freightMinor + insuranceMinor;
  const dutyRate = DUTY_RATES[category] ?? DUTY_RATES.default;
  const dutyMinor = Math.round(dutiableBase * dutyRate);
  const vatMinor = Math.round((dutiableBase + dutyMinor) * 0.075); // 7.5% VAT (NG band)
  const clearanceMinor = Math.round(fobMinor * 0.02);
  const totalMinor =
    fobMinor +
    freightMinor +
    insuranceMinor +
    dutyMinor +
    vatMinor +
    clearanceMinor;

  return {
    isImport: true,
    fobMinor,
    freightMinor,
    insuranceMinor,
    dutyMinor,
    vatMinor,
    clearanceMinor,
    totalMinor,
    shipMode,
    etaLabel: ETA[shipMode],
    originCountry: input.originCountry,
  };
}

export interface CustomsStep {
  key:
    | "origin_pickup"
    | "in_freight"
    | "arrival"
    | "customs_clearance"
    | "last_mile"
    | "delivered";
  label: string;
  detail: string;
  state: "done" | "active" | "pending";
}

// Synth a deterministic customs progress for a given order id + import flag.
// Steps "advance" based on the order id hash so different orders look different
// without storing real progress.
export function buildCustomsTimeline(orderId: string): CustomsStep[] {
  const hash = orderId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const stepIndex = hash % 5; // 0 to 4 (delivered is last)
  const steps: CustomsStep[] = [
    {
      key: "origin_pickup",
      label: "Picked up at origin",
      detail: "Shenzhen warehouse",
      state: "done",
    },
    {
      key: "in_freight",
      label: "In freight",
      detail: "Air cargo to Lagos",
      state: stepIndex >= 1 ? "done" : "pending",
    },
    {
      key: "arrival",
      label: "Arrived at hub",
      detail: "Lagos cargo terminal",
      state: stepIndex >= 2 ? "done" : "pending",
    },
    {
      key: "customs_clearance",
      label: "Customs clearance",
      detail: "Duties paid, awaiting release",
      state: stepIndex >= 3 ? "done" : "pending",
    },
    {
      key: "last_mile",
      label: "Last mile dispatch",
      detail: "Out for door delivery",
      state: stepIndex >= 4 ? "done" : "pending",
    },
    {
      key: "delivered",
      label: "Delivered",
      detail: "Handed to recipient",
      state: "pending",
    },
  ];
  // Mark the first non-done step as active.
  const firstPending = steps.findIndex((s) => s.state === "pending");
  if (firstPending !== -1) steps[firstPending].state = "active";
  return steps;
}
