import { logger } from "./logger";

/**
 * Pluggable freight-forwarder integration. v1 ships with a manual/email
 * forwarder (the back office books with a partner forwarder by email and
 * pastes the BL/AWB ref back in via the admin console). API-driven
 * providers (Forto, Flexport sandbox) plug into the same interface.
 *
 * `selectFreightProvider()` reads `FREIGHT_PROVIDER` env (`manual_email`
 * is the default). Production would set `FREIGHT_PROVIDER=forto` once
 * the contract is signed.
 */

export type ShipMode = "air" | "sea";

export interface FreightQuoteInput {
  originCountry: string;
  destinationCountry: string;
  mode: ShipMode;
  weightGrams: number;
  qty: number;
}

export interface FreightQuote {
  provider: string;
  costMinor: number;
  currencyCode: string;
  etaDays: number;
  originPort: string;
  destinationPort: string;
}

export interface FreightBookingInput extends FreightQuoteInput {
  wholesaleOrderId: string;
}

export interface FreightBookingResult {
  provider: string;
  ref: string;
  status: "pending" | "booked";
  costMinor: number;
  currencyCode: string;
  etaIso: string;
  originPort: string;
  destinationPort: string;
}

export interface FreightProvider {
  readonly name: string;
  quote(input: FreightQuoteInput): Promise<FreightQuote>;
  book(input: FreightBookingInput): Promise<FreightBookingResult>;
}

/**
 * Origin-country → primary export port lookup.
 * Conservative defaults — manual forwarder can override per booking.
 */
const ORIGIN_PORT: Record<string, string> = {
  CN: "Shenzhen Yantian",
  VN: "Ho Chi Minh City Cat Lai",
  JP: "Yokohama",
  TW: "Kaohsiung",
};
const DEST_PORT: Record<string, string> = {
  NG: "Lagos Apapa",
  GH: "Tema",
  KE: "Mombasa",
  ZA: "Durban",
  EG: "Alexandria",
  MA: "Casablanca",
  CI: "Abidjan",
  TZ: "Dar es Salaam",
  UG: "Mombasa",
  RW: "Mombasa",
  ET: "Djibouti",
  SN: "Dakar",
  CM: "Douala",
  BW: "Walvis Bay",
  ZM: "Dar es Salaam",
  CD: "Matadi",
};

const FREIGHT_USD_PER_KG: Record<ShipMode, number> = { air: 6.5, sea: 1.2 };
const ETA_DAYS: Record<ShipMode, number> = { air: 7, sea: 28 };
const MIN_USD: Record<ShipMode, number> = { air: 30, sea: 80 };

function quoteCommon(input: FreightQuoteInput, provider: string): FreightQuote {
  const weightKg = Math.max(0.1, input.weightGrams / 1000) * input.qty;
  const base = FREIGHT_USD_PER_KG[input.mode] * weightKg;
  const costUsd = Math.max(base, MIN_USD[input.mode]);
  return {
    provider,
    costMinor: Math.round(costUsd * 100),
    currencyCode: "USD",
    etaDays: ETA_DAYS[input.mode],
    originPort: ORIGIN_PORT[input.originCountry] ?? input.originCountry,
    destinationPort: DEST_PORT[input.destinationCountry] ?? input.destinationCountry,
  };
}

/**
 * Default provider. Returns a synthetic quote and a "pending" booking with
 * a reference that the back office will populate by email.
 */
class ManualEmailForwarder implements FreightProvider {
  readonly name = "manual_email";
  async quote(input: FreightQuoteInput): Promise<FreightQuote> {
    return quoteCommon(input, this.name);
  }
  async book(input: FreightBookingInput): Promise<FreightBookingResult> {
    const q = await this.quote(input);
    const etaIso = new Date(Date.now() + q.etaDays * 86_400_000).toISOString();
    logger.info(
      { wholesaleOrderId: input.wholesaleOrderId, mode: input.mode, originPort: q.originPort, destPort: q.destinationPort },
      "freight_manual_email_booking_handoff",
    );
    return {
      provider: this.name,
      ref: `MEF-${input.wholesaleOrderId.toUpperCase()}`,
      status: "pending",
      costMinor: q.costMinor,
      currencyCode: q.currencyCode,
      etaIso,
      originPort: q.originPort,
      destinationPort: q.destinationPort,
    };
  }
}

/**
 * DevMock provider for tests/CI. Returns immediate "booked" status with a
 * synthetic reference so end-to-end flows can complete without a partner.
 */
class DevMockForwarder implements FreightProvider {
  readonly name = "devmock";
  async quote(input: FreightQuoteInput): Promise<FreightQuote> {
    return quoteCommon(input, this.name);
  }
  async book(input: FreightBookingInput): Promise<FreightBookingResult> {
    const q = await this.quote(input);
    const etaIso = new Date(Date.now() + q.etaDays * 86_400_000).toISOString();
    return {
      provider: this.name,
      ref: `DEV-${Date.now().toString(36).toUpperCase()}`,
      status: "booked",
      costMinor: q.costMinor,
      currencyCode: q.currencyCode,
      etaIso,
      originPort: q.originPort,
      destinationPort: q.destinationPort,
    };
  }
}

let _provider: FreightProvider | null = null;

export function selectFreightProvider(): FreightProvider {
  if (_provider) return _provider;
  const env = (process.env.FREIGHT_PROVIDER ?? "manual_email").toLowerCase();
  switch (env) {
    case "devmock":
      _provider = new DevMockForwarder();
      break;
    case "manual_email":
    default:
      _provider = new ManualEmailForwarder();
      if (env !== "manual_email") {
        logger.warn({ requested: env }, "freight_provider_unknown_falling_back_manual_email");
      }
  }
  return _provider;
}
