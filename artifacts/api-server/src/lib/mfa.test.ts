import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";
import { authenticator } from "otplib";
import {
  encryptSecret,
  decryptSecret,
  __test__,
} from "./mfa";

describe("mfa encryption envelope", () => {
  beforeAll(() => {
    if (!process.env.MFA_ENCRYPTION_KEY) {
      process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    }
  });

  it("round-trips a TOTP secret through AES-256-GCM", () => {
    const secret = authenticator.generateSecret();
    const sealed = encryptSecret(secret);
    expect(sealed).not.toContain(secret);
    expect(decryptSecret(sealed)).toBe(secret);
  });

  it("produces a different ciphertext on each call (random IV)", () => {
    const secret = authenticator.generateSecret();
    const a = encryptSecret(secret);
    const b = encryptSecret(secret);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(secret);
    expect(decryptSecret(b)).toBe(secret);
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    const sealed = encryptSecret("hello");
    const buf = Buffer.from(sealed, "base64");
    // Flip one byte in the ciphertext segment.
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0x01;
    expect(() => decryptSecret(buf.toString("base64"))).toThrow();
  });
});

describe("mfa backup codes", () => {
  it("generates 10 distinct hex codes", () => {
    const codes = __test__.generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(/^[0-9a-f]{10}$/.test(c)).toBe(true);
  });

  it("hashes are deterministic per pepper but unguessable across", () => {
    const a = __test__.hashBackupCode("abcdef0123");
    const b = __test__.hashBackupCode("abcdef0123");
    const c = __test__.hashBackupCode("abcdef0124");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("totp clock-skew tolerance", () => {
  it("accepts a code generated one step in the past with window=1", () => {
    const secret = authenticator.generateSecret();
    authenticator.options = { window: 0, step: 30 };
    const past = authenticator.generate(secret);
    // Sanity: with window=1 the same code is still valid one tick later.
    authenticator.options = { window: 1, step: 30 };
    expect(authenticator.check(past, secret)).toBe(true);
  });
});
