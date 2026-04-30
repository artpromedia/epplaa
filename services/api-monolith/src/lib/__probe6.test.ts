import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { Server as SocketServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import RedisMock from "ioredis-mock";

function shim(c: InstanceType<typeof RedisMock>) {
  (c as any).send_command = function (cmd: string, args: any[], cb: any) {
    const m = (this as any)[cmd.toLowerCase()];
    if (typeof m !== "function") return cb(new Error("no such cmd: " + cmd));
    m.apply(this, args).then((r: any) => cb(null, r), (e: any) => cb(e));
  };
}

describe("redis adapter serverCount with shim", () => {
  it("sees other replicas after shim", async () => {
    const httpA = createServer();
    const httpB = createServer();
    const ioA = new SocketServer(httpA);
    const ioB = new SocketServer(httpB);
    const pubA = new RedisMock(), subA = new RedisMock();
    const pubB = new RedisMock(), subB = new RedisMock();
    [pubA, subA, pubB, subB].forEach(shim);
    ioA.adapter(createAdapter(pubA as never, subA as never));
    ioB.adapter(createAdapter(pubB as never, subB as never));
    await new Promise<void>((r) => httpA.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => httpB.listen(0, "127.0.0.1", r));
    await new Promise((r) => setTimeout(r, 200));
    const cA = await (ioA.of("/").adapter as any).serverCount();
    const cB = await (ioB.of("/").adapter as any).serverCount();
    console.log("serverCount A=", cA, "B=", cB);
    expect(cA).toBeGreaterThanOrEqual(2);
    expect(cB).toBeGreaterThanOrEqual(2);
    ioA.close(); ioB.close(); httpA.close(); httpB.close();
    pubA.disconnect(); subA.disconnect(); pubB.disconnect(); subB.disconnect();
  });
});
