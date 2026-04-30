import { describe, it, expect } from "vitest";
import RedisMock from "ioredis-mock";

describe("pubsub numsub", () => {
  it("counts subscribers across instances", async () => {
    const a = new RedisMock();
    const b = new RedisMock();
    await new Promise<void>((r) => b.subscribe("ch", () => r()));
    const result = await a.pubsub("NUMSUB", "ch");
    console.log("numsub:", JSON.stringify(result));
    expect(result).toEqual(["ch", 1]);
  });
});
