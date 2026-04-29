import { eq } from "drizzle-orm";
import { db, schema } from "./db";

/**
 * Shared request-side context for MFA security-tripwire emails
 * (`mfa_activated`, `mfa_backup_codes_regenerated`).
 *
 * The route layer captures these from the inbound request and hands
 * them to the lib-level helpers so the email can carry forensic
 * detail — IP, browser, device, optional approximate location —
 * without leaking Express types into the lib. Every field is
 * optional: lib-level callers (background jobs, internal admin
 * tools, unit tests) may not have a meaningful request, in which
 * case the email degrades to a "details unavailable" line rather
 * than failing or emitting half-blank fields.
 *
 * `geoCity` / `geoCountry` are accepted from the route (or any other
 * caller that resolves them via a geo provider) but are NEVER
 * looked up inside the lib — keeping the lib free of network I/O
 * and the choice of provider out of scope here.
 */
export interface MfaSecurityContext {
  ipAddress?: string;
  userAgent?: string;
  geoCity?: string;
  geoCountry?: string;
  occurredAt?: Date;
}

/**
 * Resolve the user's preferred IANA timezone for stamping security
 * emails. Mirrors the pref-resolution strategy used by
 * `notifications/prefs.ts` so a seller who set `Africa/Nairobi` in
 * their notification settings sees the same timezone in their
 * security emails as in their order updates.
 *
 * Resolution order:
 *   1. `notification_prefs.timezone` (user-set IANA string)
 *   2. Country-code → default IANA tz mapping
 *   3. `Africa/Lagos` (the platform's home tz, biggest seller base)
 *
 * Returns a string that is safe to pass to `Intl.DateTimeFormat({
 * timeZone })` — invalid values from the prefs row are filtered by
 * a runtime probe so a typo cannot crash the email build.
 */
const COUNTRY_TZ: Record<string, string> = {
  NG: "Africa/Lagos",
  ZA: "Africa/Johannesburg",
  KE: "Africa/Nairobi",
  GH: "Africa/Accra",
  EG: "Africa/Cairo",
  MA: "Africa/Casablanca",
  CI: "Africa/Abidjan",
  SN: "Africa/Dakar",
  ET: "Africa/Addis_Ababa",
  TZ: "Africa/Dar_es_Salaam",
  UG: "Africa/Kampala",
  RW: "Africa/Kigali",
  CM: "Africa/Douala",
  DZ: "Africa/Algiers",
  TN: "Africa/Tunis",
  ZM: "Africa/Lusaka",
};

const DEFAULT_TZ = "Africa/Lagos";

function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function loadUserTimezone(userId: string): Promise<string> {
  try {
    const [prefs] = await db
      .select({ timezone: schema.notificationPrefsTable.timezone })
      .from(schema.notificationPrefsTable)
      .where(eq(schema.notificationPrefsTable.userId, userId))
      .limit(1);
    const fromPrefs = (prefs?.timezone ?? "").trim();
    if (fromPrefs && isValidTimezone(fromPrefs)) return fromPrefs;
    const [user] = await db
      .select({ countryCode: schema.usersTable.countryCode })
      .from(schema.usersTable)
      .where(eq(schema.usersTable.clerkId, userId))
      .limit(1);
    const fromCountry = COUNTRY_TZ[user?.countryCode ?? "NG"];
    if (fromCountry && isValidTimezone(fromCountry)) return fromCountry;
    return DEFAULT_TZ;
  } catch {
    // DB hiccup must not poison email build — fall back to the
    // platform default. The email is still useful with a UTC-ish
    // stamp, missing it entirely (a thrown error swallowed by the
    // outer try/catch around enqueueNotification) would silently
    // drop the security alert.
    return DEFAULT_TZ;
  }
}

/**
 * Render `date` for a human reader in `tz`, e.g.
 * `"2026-04-29 14:30 (Africa/Lagos)"`. We use a stable `YYYY-MM-DD
 * HH:mm (TZ)` format rather than a locale-specific one so the same
 * email looks identical regardless of which Intl locale data the
 * Node runtime ships with — important when the email is read on
 * many different mail clients / regions.
 */
export function formatTimestampInTimezone(date: Date, tz: string): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const get = (t: Intl.DateTimeFormatPartTypes): string =>
      parts.find((p) => p.type === t)?.value ?? "";
    const y = get("year");
    const m = get("month");
    const d = get("day");
    let hh = get("hour");
    const mm = get("minute");
    // `en-CA` with `hour12: false` returns "24" at midnight in some Node
    // builds; normalise to "00" so the stamp is always a valid clock time.
    if (hh === "24") hh = "00";
    return `${y}-${m}-${d} ${hh}:${mm} (${tz})`;
  } catch {
    return `${date.toISOString()} (UTC)`;
  }
}

export interface ParsedUserAgent {
  browser: string;
  device: string;
}

/**
 * Tiny, dependency-free user-agent classifier. We pull two pieces
 * out of the raw UA string for the security email:
 *
 *   - browser: which app the user was driving (Chrome, Safari,
 *     Firefox, Edge, Opera, or "Unknown").
 *   - device: which OS / form factor (Windows, macOS, Linux,
 *     Android, iPhone, iPad, or "Unknown").
 *
 * We deliberately avoid pulling in a full UA-parsing dependency —
 * the email is human-readable forensic context, not a billing
 * dashboard, and a tiny known-good regex set keeps the surface area
 * small. The raw UA string is included verbatim alongside the
 * parsed values so a power user / support agent investigating an
 * incident can still see the full UA when the parser falls back to
 * "Unknown".
 *
 * Order of checks matters: many UAs contain multiple identifiers
 * (e.g. Edge contains "Chrome" and "Safari"), so we test for the
 * most-specific token first.
 */
export function parseUserAgent(ua: string): ParsedUserAgent {
  const trimmed = (ua ?? "").trim();
  if (!trimmed) return { browser: "Unknown", device: "Unknown" };
  let browser = "Unknown";
  if (/Edg\//i.test(trimmed)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(trimmed)) browser = "Opera";
  else if (/Firefox\//i.test(trimmed)) browser = "Firefox";
  else if (/Chrome\//i.test(trimmed)) browser = "Chrome";
  else if (/Safari\//i.test(trimmed)) browser = "Safari";
  let device = "Unknown";
  if (/iPhone/i.test(trimmed)) device = "iPhone";
  else if (/iPad/i.test(trimmed)) device = "iPad";
  else if (/Android/i.test(trimmed)) device = "Android";
  else if (/Windows/i.test(trimmed)) device = "Windows";
  else if (/Mac OS X|Macintosh/i.test(trimmed)) device = "macOS";
  else if (/Linux/i.test(trimmed)) device = "Linux";
  return { browser, device };
}

/**
 * Build the human-readable "Where this happened" block for an MFA
 * security email. When `context` is undefined OR every meaningful
 * field is empty the section degrades to a single
 * `"Where this happened: details unavailable"` line so the email
 * still ships and the recipient knows the system tried to attribute
 * the event but couldn't.
 *
 * Pure function: `tz` is supplied by the caller (resolved via
 * `loadUserTimezone`) so this helper can be unit-tested without a
 * DB round-trip.
 */
export function formatWhereThisHappenedSection(
  context: MfaSecurityContext | undefined,
  tz: string,
): string {
  const ip = (context?.ipAddress ?? "").trim();
  const ua = (context?.userAgent ?? "").trim();
  const city = (context?.geoCity ?? "").trim();
  const country = (context?.geoCountry ?? "").trim();
  const haveAny = Boolean(ip || ua || city || country || context?.occurredAt);
  if (!haveAny) {
    return "Where this happened: details unavailable.";
  }
  const lines: string[] = ["Where this happened"];
  const when = context?.occurredAt ?? new Date();
  lines.push(`When: ${formatTimestampInTimezone(when, tz)}`);
  if (ua) {
    const { browser, device } = parseUserAgent(ua);
    lines.push(`Browser: ${browser}`);
    lines.push(`Device: ${device}`);
  } else {
    lines.push("Browser: unknown");
    lines.push("Device: unknown");
  }
  lines.push(`IP: ${ip || "unknown"}`);
  // Geo is best-effort — include the line only when we actually have
  // a value, otherwise we'd promise location data we couldn't deliver.
  if (city || country) {
    const loc = [city, country].filter(Boolean).join(", ");
    lines.push(`Approximate location: ${loc}`);
  } else {
    lines.push("Approximate location: unavailable");
  }
  if (ua) {
    // Keep the raw UA at the end so a power user / support agent
    // investigating a phishy email can see the full string when our
    // tiny classifier returns "Unknown".
    lines.push(`User agent: ${ua}`);
  }
  return lines.join("\n");
}
