/**
 * Unit tests for syncGithubMirror.ts. These cover the
 * pure/deterministic helpers (URL building, ls-remote parsing, redact)
 * and the env-validation path of `syncGithubMirror()`. We intentionally
 * do NOT exercise the real network — the post-merge wiring is what
 * proves the live push works against the actual GitHub mirror, and
 * faking `git` here would just re-test the shape of `spawnSync`.
 */
import { describe, it, expect } from "vitest";
import {
  buildAuthenticatedUrl,
  parseLsRemoteSha,
  redact,
  syncGithubMirror,
  EXIT,
  DEFAULT_MIRROR_URL,
  DEFAULT_MIRROR_BRANCH,
} from "./syncGithubMirror.js";

describe("buildAuthenticatedUrl", () => {
  it("injects the GitHub-documented sentinel username and the URL-encoded token", () => {
    const url = buildAuthenticatedUrl(
      "https://github.com/artpromedia/epplaa.git",
      "ghp_abc123",
    );
    // username is the literal sentinel; token is URL-encoded into the
    // password slot. We assert via URL parsing rather than substring
    // matching so a future refactor that changes ordering still passes.
    const parsed = new URL(url);
    expect(parsed.username).toBe("x-access-token");
    expect(decodeURIComponent(parsed.password)).toBe("ghp_abc123");
    expect(parsed.host).toBe("github.com");
    expect(parsed.pathname).toBe("/artpromedia/epplaa.git");
  });

  it("URL-encodes a token containing characters that would break URL parsing", () => {
    // Future GitHub token shapes can include `:` or `@` etc.; if we
    // ever forget to encode, the URL parses with a bogus host and the
    // push silently goes to a different server. Lock that in.
    const url = buildAuthenticatedUrl(
      "https://github.com/artpromedia/epplaa.git",
      "weird:token@with/symbols",
    );
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.password)).toBe(
      "weird:token@with/symbols",
    );
    expect(parsed.host).toBe("github.com");
  });

  it("refuses to embed a token in an http:// URL", () => {
    expect(() =>
      buildAuthenticatedUrl("http://github.com/artpromedia/epplaa.git", "tok"),
    ).toThrow(/https/);
  });

  it("rejects an empty token", () => {
    expect(() =>
      buildAuthenticatedUrl("https://github.com/artpromedia/epplaa.git", ""),
    ).toThrow(/non-empty/);
  });
});

describe("parseLsRemoteSha", () => {
  it("returns the SHA for the requested branch", () => {
    const stdout =
      "ff41efbc62ebe9238b74d9232f19a9677bd8f95c\trefs/heads/main\n" +
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\trefs/heads/other\n";
    expect(parseLsRemoteSha(stdout, "main")).toBe(
      "ff41efbc62ebe9238b74d9232f19a9677bd8f95c",
    );
    expect(parseLsRemoteSha(stdout, "other")).toBe(
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
  });

  it("returns null when the remote has no such branch (empty output)", () => {
    expect(parseLsRemoteSha("", "main")).toBeNull();
  });

  it("returns null when the only output is a different branch", () => {
    const stdout =
      "ff41efbc62ebe9238b74d9232f19a9677bd8f95c\trefs/heads/develop\n";
    expect(parseLsRemoteSha(stdout, "main")).toBeNull();
  });

  it("ignores garbage lines that aren't a 40-char hex SHA", () => {
    const stdout =
      "not-a-sha\trefs/heads/main\n" +
      "ff41efbc62ebe9238b74d9232f19a9677bd8f95c\trefs/heads/main\n";
    expect(parseLsRemoteSha(stdout, "main")).toBe(
      "ff41efbc62ebe9238b74d9232f19a9677bd8f95c",
    );
  });
});

describe("redact", () => {
  it("replaces the raw token in a string", () => {
    expect(redact("fatal: ghp_abc denied", "ghp_abc")).toBe("fatal: *** denied");
  });

  it("replaces the URL-encoded token too (so URL-shaped errors don't leak)", () => {
    const tok = "weird:token";
    const enc = encodeURIComponent(tok);
    expect(redact(`https://x:${enc}@github.com`, tok)).not.toContain(enc);
    expect(redact(`https://x:${enc}@github.com`, tok)).toContain("***");
  });

  it("is a no-op when the token is empty (defensive — would otherwise blank everything)", () => {
    expect(redact("hello world", "")).toBe("hello world");
  });
});

describe("syncGithubMirror — env validation", () => {
  it("exits with EXIT.MISSING_TOKEN and a clear message when GITHUB_TOKEN is unset", () => {
    const lines: string[] = [];
    const result = syncGithubMirror({
      cwd: "/tmp", // never reached because we bail on the missing token
      env: {},
      log: (l) => lines.push(l),
    });
    expect(result.exit).toBe(EXIT.MISSING_TOKEN);
    expect(result.pushed).toBe(false);
    expect(lines.join("\n")).toMatch(/GITHUB_TOKEN/);
  });

  it("uses the documented defaults when GITHUB_MIRROR_URL/BRANCH are unset", () => {
    // We can't run the full path here without git, but we can at least
    // confirm the defaults exist and are the values the task spec calls
    // out — protects against a future rename silently moving the mirror.
    expect(DEFAULT_MIRROR_URL).toBe("https://github.com/artpromedia/epplaa.git");
    expect(DEFAULT_MIRROR_BRANCH).toBe("main");
  });
});
