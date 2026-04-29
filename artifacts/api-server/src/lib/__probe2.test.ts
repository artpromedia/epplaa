import { describe, it, expect } from "vitest";
import RedisMock from "ioredis-mock";

describe("psubscribe", () => {
  it("crosses instances", async () => {
    const a = new RedisMock();
    const b = new RedisMock();
    const got = await new Promise<string | null>((resolve) => {
      b.on("pmessage", (_p, _ch, m) => resolve(m));
      b.psubscribe("test.*", () => { a.publish("test.foo", "hello-p"); });
      setTimeout(() => resolve(null), 500);
    });
    expect(got).toBe("hello-p");
  });
});
