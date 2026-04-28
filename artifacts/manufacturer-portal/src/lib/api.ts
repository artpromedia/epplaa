type TokenGetter = () => Promise<string | null>;

let tokenGetter: TokenGetter | null = null;

export function setApiTokenGetter(g: TokenGetter | null): void {
  tokenGetter = g;
}

const API_PREFIX = "/api";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_PREFIX}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (tokenGetter) {
    try {
      const tok = await tokenGetter();
      if (tok) headers.Authorization = `Bearer ${tok}`;
    } catch {
      /* ignore */
    }
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const detail =
      (parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)
        ? String((parsed as Record<string, unknown>).error)
        : res.statusText) || "request_failed";
    throw new ApiError(res.status, parsed, detail);
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

// ----------------- Domain types (kept loose, mirrors server) ------------------
export type Manufacturer = {
  id: string;
  userId: string;
  originCountry: string;
  legalName: string;
  contactEmail: string;
  contactPhone: string | null;
  exportLicenceNumber: string | null;
  status: "pending" | "review" | "approved" | "rejected" | "suspended";
  application: Record<string, unknown> | null;
  createdAtIso: string;
  updatedAtIso: string;
};

export type ManufacturerMeResponse = {
  status: "none" | Manufacturer["status"];
  manufacturer: Manufacturer | null;
};

export type ManufacturerKyc = {
  id: string;
  manufacturerId: string;
  kind: string;
  documentUrl: string;
  status: "pending" | "approved" | "rejected";
  reviewedBy: string | null;
  reviewedAtIso: string | null;
  rejectReason: string | null;
  createdAtIso: string;
  updatedAtIso: string;
};

export type ManufacturerListing = {
  id: string;
  manufacturerId: string;
  sku: string;
  title: string;
  description: string;
  hsCode: string;
  originCountry: string;
  originCurrencyCode: string;
  wholesalePriceMinor: number;
  moq: number;
  leadDays: number;
  weightGrams: number;
  dimensions: Record<string, unknown> | null;
  images: string[];
  category: string;
  status: "draft" | "active" | "paused";
  createdAtIso: string;
  updatedAtIso: string;
};

export type WholesaleOrder = {
  id: string;
  listingId: string;
  manufacturerId: string;
  sellerUserId: string;
  qty: number;
  fobMinor: number;
  originCurrencyCode: string;
  freightMinor: number;
  insuranceMinor: number;
  dutyMinor: number;
  vatMinor: number;
  clearanceMinor: number;
  landedTotalMinor: number;
  destinationCurrencyCode: string;
  destinationCountryCode: string;
  fxRate: number;
  status: string;
  freightBookingId: string | null;
  etaIso: string | null;
  shipMode: string | null;
  notes: string | null;
  createdAtIso: string;
  updatedAtIso: string;
};

export type CustomsEvent = {
  id: string;
  kind: string;
  note: string | null;
  payload: Record<string, unknown> | null;
  createdAtIso: string;
};

export type FreightBookingView = {
  id: string;
  mode: string;
  forwarder: string;
  ref: string | null;
  originPort: string | null;
  destinationPort: string | null;
  status: string;
  etaIso: string | null;
  actualEtaIso: string | null;
  costMinor: number | null;
  currencyCode: string | null;
};

export type ManufacturerOrderDetail = {
  order: WholesaleOrder;
  events: CustomsEvent[];
  booking: FreightBookingView | null;
};

export type ManufacturerPayout = {
  id: string;
  amountMinor: number;
  currencyCode: string;
  status: string;
  reference: string | null;
  requestedAtIso: string;
  paidAtIso: string | null;
};

export const manufacturerApi = {
  me: () => api.get<ManufacturerMeResponse>("/manufacturer/me"),
  apply: (body: Partial<Manufacturer> & { originCountry: string; legalName: string }) =>
    api.post<ManufacturerMeResponse>("/manufacturer/apply", body),
  listKyc: () => api.get<ManufacturerKyc[]>("/manufacturer/kyc"),
  uploadKyc: (body: { kind: string; documentUrl: string }) =>
    api.post<ManufacturerKyc>("/manufacturer/kyc", body),
  listListings: () => api.get<ManufacturerListing[]>("/manufacturer/listings"),
  createListing: (body: Partial<ManufacturerListing> & { title: string }) =>
    api.post<ManufacturerListing>("/manufacturer/listings", body),
  updateListing: (id: string, body: Partial<ManufacturerListing>) =>
    api.patch<ManufacturerListing>(`/manufacturer/listings/${id}`, body),
  deleteListing: (id: string) => api.delete<void>(`/manufacturer/listings/${id}`),
  listOrders: () => api.get<WholesaleOrder[]>("/manufacturer/orders"),
  getOrder: (id: string) => api.get<ManufacturerOrderDetail>(`/manufacturer/orders/${id}`),
  shipOrder: (id: string) => api.post<WholesaleOrder>(`/manufacturer/orders/${id}/ship`),
  listPayouts: () => api.get<ManufacturerPayout[]>("/manufacturer/payouts"),
};

// Money formatter — works with minor units.
export function formatMinor(amountMinor: number, currency: string): string {
  if (!Number.isFinite(amountMinor)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}
