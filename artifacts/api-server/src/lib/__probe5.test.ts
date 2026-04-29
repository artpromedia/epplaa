import { describe, it, expect } from "vitest";
import RedisMock from "ioredis-mock";

describe("send_command shim", () => {
  it("can shim send_command -> pubsub via .pubsub()", async () => {
    const a = new RedisMock();
    const b = new RedisMock();
    await new Promise<void>((r) => b.subscribe("ch", () => r()));
    (a as unknown as { send_command: Function }).send_command = function (cmd: string, args: string[], cb: Function) {
      const m = (this as Record<string, unknown>)[cmd.toLowerCase()];
      if (typeof m !== "function") return cb(new Error("no such cmd: " + cmd));
      (m as Function).apply(this, args).then((res: unknown) => cb(null, res), (err: Error) => cb(err));
    };
    const result = await new Promise((res, rej) =>
      (a as unknown as { send_command: Function }).send_command("PUBSUB", ["NUMSUB", "ch"], (e: Error | null, r: unknown) => e ? rej(e) : res(r))
    );
    console.log("send_command result:", result);
    expect(result).toEqual(["ch", 1]);
  });
});
