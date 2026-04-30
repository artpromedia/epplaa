import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as SocketServer } from "socket.io";
import { io as ioClient } from "socket.io-client";
import { createAdapter } from "@socket.io/redis-adapter";
import RedisMock from "ioredis-mock";

function shim(c: InstanceType<typeof RedisMock>) {
  (c as any).send_command = function (cmd: string, args: any[], cb: any) {
    const m = (this as any)[cmd.toLowerCase()];
    if (typeof m !== "function") return cb(new Error("no such cmd: " + cmd));
    m.apply(this, args).then((r: any) => cb(null, r), (e: any) => cb(e));
  };
}

describe("redis adapter fetchSockets", () => {
  it("aggregates sockets across replicas", async () => {
    const httpA = createServer();
    const httpB = createServer();
    const ioA = new SocketServer(httpA);
    const ioB = new SocketServer(httpB);
    const pubA = new RedisMock(), subA = new RedisMock();
    const pubB = new RedisMock(), subB = new RedisMock();
    [pubA, subA, pubB, subB].forEach(shim);
    ioA.adapter(createAdapter(pubA as never, subA as never, { requestsTimeout: 2000 }));
    ioB.adapter(createAdapter(pubB as never, subB as never, { requestsTimeout: 2000 }));
    await new Promise<void>((r) => httpA.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => httpB.listen(0, "127.0.0.1", r));
    const portA = (httpA.address() as AddressInfo).port;
    const portB = (httpB.address() as AddressInfo).port;
    await new Promise((r) => setTimeout(r, 200));

    const cA = ioClient(`http://127.0.0.1:${portA}/`, { transports: ["websocket"], reconnection: false });
    const cB = ioClient(`http://127.0.0.1:${portB}/`, { transports: ["websocket"], reconnection: false });
    await new Promise<void>((r) => cA.on("connect", () => r()));
    await new Promise<void>((r) => cB.on("connect", () => r()));
    await new Promise((r) => setTimeout(r, 100));

    const t0 = Date.now();
    const sockets = await ioA.of("/").fetchSockets();
    console.log("fetchSockets returned", sockets.length, "in", Date.now() - t0, "ms");
    expect(sockets.length).toBe(2);

    cA.disconnect(); cB.disconnect();
    ioA.close(); ioB.close(); httpA.close(); httpB.close();
    pubA.disconnect(); subA.disconnect(); pubB.disconnect(); subB.disconnect();
  });
});
