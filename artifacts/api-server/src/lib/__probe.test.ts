import { describe, it, expect } from "vitest";
import RedisMock from "ioredis-mock";

describe("ioredis-mock pubsub probe", () => {
  it("crosses instances (duplicate)", async () => {
    const base = new RedisMock();
    const a = base.duplicate();
    const b = base.duplicate();
    const got = await new Promise<string | null>((resolve) => {
      b.on("message", (_ch, m) => resolve(m));
      b.subscribe("test", () => { a.publish("test", "hello-dup"); });
      setTimeout(() => resolve(null), 300);
    });
    expect(got).toBe("hello-dup");
  });
  it("crosses instances (separate)", async () => {
    const a = new RedisMock();
    const b = new RedisMock();
    const got = await new Promise<string | null>((resolve) => {
      b.on("message", (_ch, m) => resolve(m));
      b.subscribe("test", () => { a.publish("test", "hello-sep"); });
      setTimeout(() => resolve(null), 300);
    });
    expect(got).toBe("hello-sep");
  });
});
