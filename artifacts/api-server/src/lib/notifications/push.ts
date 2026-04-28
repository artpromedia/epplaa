import { createCipheriv, createECDH, createHmac, createSign, randomBytes } from "node:crypto";
import { logger } from "../logger";
import type { ChannelKind, NotificationChannel, NotificationMessage, SendResult } from "./types";

/**
 * RFC 5869 HKDF-SHA256 (extract + expand). Returns the first `length` bytes
 * of the expanded output. Used to derive the AES key and nonce for RFC 8291
 * Web Push payload encryption.
 */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  let prev = Buffer.alloc(0);
  let out = Buffer.alloc(0);
  let counter = 1;
  while (out.length < length) {
    prev = createHmac("sha256", prk)
      .update(Buffer.concat([prev, info, Buffer.from([counter])]))
      .digest();
    out = Buffer.concat([out, prev]);
    counter++;
  }
  return out.subarray(0, length);
}

/**
 * Encrypt a Web Push payload per RFC 8291 (aes128gcm content encoding,
 * RFC 8188 framing). Returns the binary body to POST to the push endpoint.
 * Caller is responsible for setting Content-Encoding: aes128gcm and the
 * VAPID Authorization header.
 */
function encryptAes128gcm(payload: Buffer, p256dhBase64Url: string, authBase64Url: string): Buffer {
  const ua_pub = Buffer.from(p256dhBase64Url, "base64url");
  const auth = Buffer.from(authBase64Url, "base64url");
  const ecdh = createECDH("prime256v1");
  const as_pub = ecdh.generateKeys();
  const shared = ecdh.computeSecret(ua_pub);
  const salt = randomBytes(16);

  // PRK_key = HKDF(auth, shared, "WebPush: info\0" || ua_pub || as_pub, 32)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), ua_pub, as_pub]);
  const ikm = hkdf(auth, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

  // RFC 8188 record: payload || 0x02 (last-record delimiter) — no extra padding.
  const padded = Buffer.concat([payload, Buffer.from([0x02])]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  // Header: salt(16) || rs(4 BE = 4096) || idlen(1) || keyid(as_pub).
  const header = Buffer.concat([
    salt,
    Buffer.from([0x00, 0x00, 0x10, 0x00]),
    Buffer.from([as_pub.length]),
    as_pub,
  ]);
  return Buffer.concat([header, ct]);
}

/**
 * FCM adapter for native push (Android / iOS / web with FCM SDK).
 *
 * Uses the HTTP v1 API. Requires FCM_SERVICE_ACCOUNT_JSON (base64-encoded)
 * with `client_email` and `private_key`. We mint short-lived OAuth tokens
 * via the JWT-bearer flow so we do not need any extra Google SDK.
 */
export class FcmChannel implements NotificationChannel {
  readonly kind: ChannelKind = "push";
  private cachedToken: { token: string; expiresAt: number } | null = null;
  private cachedSa: { client_email: string; private_key: string; project_id: string } | null = null;

  isConfigured(): boolean {
    return Boolean(process.env.FCM_SERVICE_ACCOUNT_JSON);
  }

  private serviceAccount() {
    if (this.cachedSa) return this.cachedSa;
    const raw = process.env.FCM_SERVICE_ACCOUNT_JSON ?? "";
    if (!raw) return null;
    try {
      const decoded = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf-8");
      const sa = JSON.parse(decoded) as { client_email: string; private_key: string; project_id: string };
      this.cachedSa = sa;
      return sa;
    } catch (err) {
      logger.error({ err: (err as Error).message }, "fcm_service_account_invalid");
      return null;
    }
  }

  private async accessToken(): Promise<string | null> {
    const sa = this.serviceAccount();
    if (!sa) return null;
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.token;
    }
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const claims = Buffer.from(
      JSON.stringify({
        iss: sa.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    ).toString("base64url");
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const signature = signer.sign(sa.private_key).toString("base64url");
    const assertion = `${header}.${claims}.${signature}`;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  async send(msg: NotificationMessage): Promise<SendResult> {
    const sa = this.serviceAccount();
    if (!sa) {
      logger.info({ kind: this.kind, to: msg.to, title: msg.title }, "fcm_dev_send");
      return { ok: true, providerMessageId: `fcm_dev_${Date.now()}` };
    }
    const token = await this.accessToken();
    if (!token) return { ok: false, errorMessage: "fcm_token_failed" };
    try {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token: msg.to,
            notification: { title: msg.title, body: msg.body },
            data: { url: msg.url ?? "", ...((msg.payload as Record<string, string>) ?? {}) },
          },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { name?: string; error?: { message?: string } };
      if (!res.ok) return { ok: false, errorCode: String(res.status), errorMessage: data.error?.message ?? "fcm_failed" };
      return { ok: true, providerMessageId: data.name };
    } catch (err) {
      return { ok: false, errorMessage: (err as Error).message };
    }
  }
}

/**
 * Web Push (VAPID) adapter. Sends to the browser PushSubscription stored as
 * JSON in `push_tokens.token`. Encryption is delegated to the browser via
 * the VAPID-only "no payload" pattern: we send a notification-name in the
 * Topic header so the SW can fetch fresh content. This avoids pulling in
 * a heavy crypto lib for ECDH-ES.
 */
export class WebPushChannel implements NotificationChannel {
  readonly kind: ChannelKind = "push";

  isConfigured(): boolean {
    return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  }

  async send(msg: NotificationMessage): Promise<SendResult> {
    if (!this.isConfigured()) {
      logger.info({ kind: this.kind, title: msg.title }, "webpush_dev_send");
      return { ok: true, providerMessageId: `webpush_dev_${Date.now()}` };
    }
    let sub: { endpoint: string; keys?: { p256dh: string; auth: string } } | null = null;
    try {
      sub = JSON.parse(msg.to);
    } catch {
      return { ok: false, errorMessage: "invalid_subscription" };
    }
    if (!sub?.endpoint) return { ok: false, errorMessage: "no_endpoint" };
    const audience = new URL(sub.endpoint).origin;
    const subject = process.env.VAPID_SUBJECT || "mailto:notifications@epplaa.app";
    const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
    const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ aud: audience, exp, sub: subject })).toString("base64url");
    // ES256 signing requires the EC private key in PEM form. Skip if the env
    // key isn't a PEM (prevents crashes when only a placeholder is set).
    const pk = process.env.VAPID_PRIVATE_KEY ?? "";
    if (!pk.includes("BEGIN")) {
      logger.warn("vapid_private_key_not_pem_skip");
      return { ok: false, errorMessage: "vapid_private_key_not_pem" };
    }
    // VAPID requires ES256. Fail closed if signing fails — an HMAC
    // fallback would produce a cryptographically invalid token that
    // browsers/push services would either accept incorrectly or reject
    // silently. Outbox retry/backoff is the authoritative reliability
    // layer.
    let signature: string;
    try {
      const signer = createSign("SHA256");
      signer.update(`${header}.${claims}`);
      signature = signer.sign(pk).toString("base64url");
    } catch (err) {
      logger.error({ err: (err as Error).message }, "vapid_es256_sign_failed");
      return { ok: false, errorMessage: "vapid_es256_sign_failed" };
    }
    const jwt = `${header}.${claims}.${signature}`;

    // RFC 8291 encrypted payload: title/body/url/payload travel inside the
    // push so the SW can render a contextual notification without a
    // round-trip back to the API.
    let body: Buffer | undefined;
    const headers: Record<string, string> = {
      authorization: `vapid t=${jwt}, k=${process.env.VAPID_PUBLIC_KEY}`,
      ttl: "86400",
      topic: msg.payload?.topic ? String(msg.payload.topic) : "default",
    };
    if (sub.keys?.p256dh && sub.keys?.auth) {
      try {
        const json = JSON.stringify({
          title: msg.title,
          body: msg.body,
          url: msg.url,
          payload: msg.payload ?? {},
        });
        body = encryptAes128gcm(Buffer.from(json, "utf8"), sub.keys.p256dh, sub.keys.auth);
        headers["content-encoding"] = "aes128gcm";
        headers["content-type"] = "application/octet-stream";
        headers["content-length"] = String(body.length);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "webpush_encrypt_failed_sending_empty");
        body = undefined;
        headers["content-length"] = "0";
      }
    } else {
      headers["content-length"] = "0";
    }
    try {
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers,
        body,
      });
      if (!res.ok && res.status !== 201) {
        return { ok: false, errorCode: String(res.status), errorMessage: await res.text() };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, errorMessage: (err as Error).message };
    }
  }
}
