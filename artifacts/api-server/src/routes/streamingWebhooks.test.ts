import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyCfSignature, signCloudflareWebhookForTest } from "./streamingWebhooks";

describe("verifyCfSignature — Cloudflare Stream Webhook-Signature header", () => {
  // Format per CF docs:
  //   Webhook-Signature: time=<unix>,sig1=<hex hmac sha256>
  // where sig1 = HMAC-SHA256(secret, "<unix>.<body>"). The check also
  // rejects timestamps more than 5 minutes off wall-clock to prevent
  // replay attacks.

  const SECRET = "super-secret-shared-with-cloudflare";
  const BODY = Buffer.from(
    JSON.stringify({
      uid: "vid_abc",
      status: { state: "ready" },
      meta: { streamId: "str_xyz" },
    }),
    "utf8",
  );

  it("accepts a freshly-signed signature with the right secret", () => {
    const header = signCloudflareWebhookForTest(BODY, SECRET);
    expect(verifyCfSignature(BODY, header, SECRET)).toBe(true);
  });

  it("rejects a missing/empty header", () => {
    expect(verifyCfSignature(BODY, "", SECRET)).toBe(false);
  });

  it("rejects a malformed header (no time= or sig1= parts)", () => {
    expect(verifyCfSignature(BODY, "garbage=value", SECRET)).toBe(false);
    expect(verifyCfSignature(BODY, "time=123", SECRET)).toBe(false);
    expect(verifyCfSignature(BODY, "sig1=deadbeef", SECRET)).toBe(false);
  });

  it("rejects a signature computed under a different secret", () => {
    const header = signCloudflareWebhookForTest(BODY, "different-secret");
    expect(verifyCfSignature(BODY, header, SECRET)).toBe(false);
  });

  it("rejects a signature whose body has been tampered with", () => {
    const header = signCloudflareWebhookForTest(BODY, SECRET);
    const tampered = Buffer.from(
      JSON.stringify({ uid: "vid_evil", status: { state: "ready" }, meta: { streamId: "str_xyz" } }),
      "utf8",
    );
    expect(verifyCfSignature(tampered, header, SECRET)).toBe(false);
  });

  it("rejects a signature whose timestamp is > 5 minutes old (anti-replay)", () => {
    const oldTs = Math.floor(Date.now() / 1000) - 6 * 60;
    const header = signCloudflareWebhookForTest(BODY, SECRET, oldTs);
    expect(verifyCfSignature(BODY, header, SECRET)).toBe(false);
  });

  it("rejects a signature whose timestamp is > 5 minutes in the future (clock-skew safety)", () => {
    const futureTs = Math.floor(Date.now() / 1000) + 6 * 60;
    const header = signCloudflareWebhookForTest(BODY, SECRET, futureTs);
    expect(verifyCfSignature(BODY, header, SECRET)).toBe(false);
  });

  it("accepts signatures with sig1 hex value containing '=' characters in adjacent parts (defensive parser)", () => {
    // Defensive parse: the format is comma-separated k=v pairs but the
    // hex sig itself is just [0-9a-f]. The parser uses indexOf so a
    // future addition of a base64 sig algo with padding wouldn't break
    // adjacent fields.
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", SECRET)
      .update(`${ts}.${BODY.toString("utf8")}`)
      .digest("hex");
    const header = `time=${ts},sig1=${sig}`;
    expect(verifyCfSignature(BODY, header, SECRET)).toBe(true);
  });

  it("rejects a length-mismatched sig1 even if the prefix would otherwise match", () => {
    const header = signCloudflareWebhookForTest(BODY, SECRET);
    // Truncate the sig — timing-safe compare must short-circuit on
    // length mismatch instead of throwing.
    const truncated = header.slice(0, header.length - 4);
    expect(verifyCfSignature(BODY, truncated, SECRET)).toBe(false);
  });
});
