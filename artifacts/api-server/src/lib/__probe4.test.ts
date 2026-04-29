import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { Server as SocketServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import RedisMock from "ioredis-mock";

describe("redis adapter serverCount", () => {
  it("sees other replicas", async () => {
    const httpA = createServer();
    const httpB = createServer();
    const ioA = new SocketServer(httpA);
    const ioB = new SocketServer(httpB);
    const pubA = new RedisMock(), subA = new RedisMock();
    const pubB = new RedisMock(), subB = new RedisMock();
    ioA.adapter(createAdapter(pubA as never, subA as never));
    ioB.adapter(createAdapter(pubB as never, subB as never));
    await new Promise<void>((r) => httpA.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => httpB.listen(0, "127.0.0.1", r));
    // Wait for adapters to subscribe
    await new Promise((r) => setTimeout(r, 200));
    const adapterA = ioA.of("/").adapter as unknown as { serverCount: () => Promise<number> };
    const adapterB = ioB.of("/").adapter as unknown as { serverCount: () => Promise<number> };
    const cA = await adapterA.serverCount();
    const cB = await adapterB.serverCount();
    console.log("serverCount A=", cA, "B=", cB);
    expect(cA).toBeGreaterThanOrEqual(2);
    expect(cB).toBeGreaterThanOrEqual(2);
    ioA.close();
    ioB.close();
    httpA.close();
    httpB.close();
    pubA.disconnect(); subA.disconnect();
    pubB.disconnect(); subB.disconnect();
  });
});
