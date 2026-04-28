type TokenGetter = () => Promise<string | null>;
type CsrfRefresher = () => Promise<string | null>;

let tokenGetter: TokenGetter | null = null;
let csrfToken: string | null = null;
let csrfRefresher: CsrfRefresher | null = null;

export function setApiTokenGetter(g: TokenGetter | null): void {
  tokenGetter = g;
}

/**
 * Stash the current CSRF double-submit token. Attached as `X-CSRF-Token`
 * on every mutating request (POST/PUT/PATCH/DELETE). See
 * `artifacts/api-server/src/middlewares/csrf.ts` for the server contract.
 */
export function setApiCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getApiCsrfToken(): string | null {
  return csrfToken;
}

/**
 * Register a refresher that fetches a fresh CSRF token (typically by
 * calling `GET /api/csrf-token`) so the client can recover from a 403
 * `csrf_failed` by retrying once.
 */
export function setApiCsrfRefresher(r: CsrfRefresher | null): void {
  csrfRefresher = r;
}

const API_PREFIX = "/api";
const CSRF_HEADER = "X-CSRF-Token";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function isCsrfFailure(body: unknown): boolean {
  return (
    !!body &&
    typeof body === "object" &&
    (body as Record<string, unknown>).error === "csrf_failed"
  );
}

async function buildHeaders(
  hasBody: boolean,
  isMutating: boolean,
  csrfOverride?: string | null,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (hasBody) headers["Content-Type"] = "application/json";
  if (tokenGetter) {
    try {
      const tok = await tokenGetter();
      if (tok) headers.Authorization = `Bearer ${tok}`;
    } catch {
      /* ignore */
    }
  }
  const tokenToSend = csrfOverride ?? csrfToken;
  if (isMutating && tokenToSend) {
    headers[CSRF_HEADER] = tokenToSend;
  }
  return headers;
}

async function readResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_PREFIX}${path}`;
  const isMutating = MUTATING.has(method.toUpperCase());
  const hasBody = body !== undefined;

  const headers = await buildHeaders(hasBody, isMutating);
  const init: RequestInit = {
    method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
    credentials: "include",
  };

  let res = await fetch(url, init);
  let parsed = await readResponse(res);

  // Recover from a stale CSRF token: refresh once and retry. Only meaningful
  // for cookie-session callers; bearer-auth requests are exempt server-side
  // so they shouldn't see this 403 in the first place.
  if (
    !res.ok &&
    res.status === 403 &&
    isMutating &&
    csrfRefresher &&
    isCsrfFailure(parsed)
  ) {
    let fresh: string | null = null;
    try {
      fresh = await csrfRefresher();
    } catch {
      fresh = null;
    }
    if (fresh) {
      const retryHeaders = await buildHeaders(hasBody, isMutating, fresh);
      res = await fetch(url, { ...init, headers: retryHeaders });
      parsed = await readResponse(res);
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
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
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
