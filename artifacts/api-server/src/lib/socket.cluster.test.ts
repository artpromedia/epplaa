import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as SocketServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { createAdapter } from "@socket.io/redis-adapter";
import RedisMock from "ioredis-mock";
import { getRoomSize } from "./socket";

// These tests pin down the cluster behaviour we need for task #21:
// once @socket.io/redis-adapter is wired up, two API instances act
// like one — broadcasts cross instances and `getRoomSize` is the
// helper used to compute one global viewer count instead of the
// per-process count from `adapter.rooms`.
//
// We stand up two real Socket.IO servers on local HTTP servers, each
// with its own ioredis-mock pub/sub pair. ioredis-mock shares its
// pub/sub bus across instances in-process, which is enough to model
// two replicas talking to the same Redis for fan-out broadcasts.

interface FakeReplica {
  http: HttpServer;
  io: SocketServer;
  url: string;
  pub: InstanceType<typeof RedisMock>;
  sub: InstanceType<typeof RedisMock>;
}

async function spawnReplica(): Promise<FakeReplica> {
  const http = createServer();
  const io = new SocketServer(http, {
    // Match prod path so client URL composition mirrors real wiring.
    path: "/api/socket.io",
    cors: { origin: true, credentials: true },
  });
  const pub = new RedisMock();
  const sub = new RedisMock();
  io.adapter(createAdapter(pub as never, sub as never));

  // Trivial namespace handler for /streams. Mirrors production:
  // anonymous connect -> can join a stream room -> events broadcast
  // to the room. We deliberately keep this thin so the test
  // exercises the adapter contract, not full bootstrap.
  io.of("/streams").on("connection", (socket) => {
    socket.on("join", async (streamId: string) => {
      await socket.join(`stream:${streamId}`);
      socket.emit("joined", streamId);
    });
    socket.on(
      "broadcast",
      (payload: { streamId: string; text: string }) => {
        io.of("/streams")
          .to(`stream:${payload.streamId}`)
          .emit("chat:message", payload);
      },
    );
    socket.on(
      "burst",
      (payload: { streamId: string; kind: string; count: number }) => {
        io.of("/streams")
          .to(`stream:${payload.streamId}`)
          .emit("reaction:burst", payload);
      },
    );
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const addr = http.address() as AddressInfo;
  return {
    http,
    io,
    pub,
    sub,
    url: `http://127.0.0.1:${addr.port}`,
  };
}

async function teardownReplica(replica: FakeReplica): Promise<void> {
  await new Promise<void>((resolve) => replica.io.close(() => resolve()));
  await new Promise<void>((resolve) => {
    if (!replica.http.listening) return resolve();
    replica.http.close(() => resolve());
  });
  replica.pub.disconnect();
  replica.sub.disconnect();
}

function connectClient(url: string): Promise<ClientSocket> {
  const socket = ioClient(`${url}/streams`, {
    path: "/api/socket.io",
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`connect timeout: ${url}`)),
      4000,
    );
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function joinRoom(
  socket: ClientSocket,
  streamId: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("join timeout")), 2000);
    socket.once("joined", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.emit("join", streamId);
  });
}

function waitForEvent<T>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`did not receive ${event}`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe("Socket.IO cluster broadcast behaviour with the Redis adapter", () => {
  let A: FakeReplica;
  let B: FakeReplica;

  beforeEach(async () => {
    [A, B] = await Promise.all([spawnReplica(), spawnReplica()]);
  });

  afterEach(async () => {
    await Promise.all([teardownReplica(A), teardownReplica(B)]);
  });

  // The whole point of task #21: chat sent from instance A's connected
  // client must reach a viewer connected to instance B. Without the
  // adapter this test would hang and time out on `chat:message`.
  it(
    "broadcasts chat across replicas so viewers on different instances see the same message",
    async () => {
      const clientA = await connectClient(A.url);
      const clientB = await connectClient(B.url);
      try {
        await joinRoom(clientA, "s1");
        await joinRoom(clientB, "s1");

        const received = waitForEvent<{ streamId: string; text: string }>(
          clientB,
          "chat:message",
        );
        clientA.emit("broadcast", { streamId: "s1", text: "hello cluster" });
        const payload = await received;
        expect(payload).toEqual({ streamId: "s1", text: "hello cluster" });
      } finally {
        clientA.disconnect();
        clientB.disconnect();
      }
    },
    10_000,
  );

  // Reactions take the same fan-out path as chat. We assert it
  // explicitly so a future refactor that bypasses `ns.to(room).emit`
  // (e.g. iterating `adapter.rooms` and emitting per socket) gets
  // caught — that pattern would silently lose cluster delivery.
  it(
    "broadcasts reaction bursts across replicas",
    async () => {
      const clientA = await connectClient(A.url);
      const clientB = await connectClient(B.url);
      try {
        await joinRoom(clientA, "s1");
        await joinRoom(clientB, "s1");

        const received = waitForEvent<{
          streamId: string;
          kind: string;
          count: number;
        }>(clientB, "reaction:burst");
        clientA.emit("burst", { streamId: "s1", kind: "heart", count: 3 });
        const payload = await received;
        expect(payload).toEqual({ streamId: "s1", kind: "heart", count: 3 });
      } finally {
        clientA.disconnect();
        clientB.disconnect();
      }
    },
    10_000,
  );

  // Sanity-check that the per-instance `adapter.rooms` map (the data
  // we deliberately stopped trusting for viewer count) only sees this
  // process's sockets. This documents *why* `getRoomSize` switched to
  // `fetchSockets` and prevents a future refactor from regressing to
  // it.
  it(
    "per-instance adapter.rooms only sees local sockets — proving why we use fetchSockets",
    async () => {
      const clientA = await connectClient(A.url);
      const clientB = await connectClient(B.url);
      try {
        await joinRoom(clientA, "s1");
        await joinRoom(clientB, "s1");
        await new Promise((r) => setTimeout(r, 50));

        expect(
          A.io.of("/streams").adapter.rooms.get("stream:s1")?.size,
        ).toBe(1);
        expect(
          B.io.of("/streams").adapter.rooms.get("stream:s1")?.size,
        ).toBe(1);
      } finally {
        clientA.disconnect();
        clientB.disconnect();
      }
    },
    10_000,
  );
});

describe("getRoomSize", () => {
  // Production path: delegates to the namespace's own `fetchSockets`,
  // which (with the Redis adapter wired up) goes cluster-wide. This
  // test pins down that we are NOT reading from the local-only
  // `adapter.rooms` map — that was the original bug.
  it("uses fetchSockets so the count covers every replica, not just this process", async () => {
    const calls: string[] = [];
    const fakeNs = {
      in(room: string) {
        calls.push(`in:${room}`);
        return {
          async fetchSockets() {
            calls.push("fetchSockets");
            // Pretend the adapter aggregated 3 sockets from across
            // replicas; the local map only knows about 1.
            return [{ id: "a" }, { id: "b" }, { id: "c" }];
          },
        };
      },
      adapter: {
        rooms: new Map<string, Set<string>>([
          ["stream:s1", new Set(["only-local"])],
        ]),
      },
    };
    const n = await getRoomSize(
      fakeNs as unknown as Parameters<typeof getRoomSize>[0],
      "stream:s1",
    );
    expect(n).toBe(3);
    expect(calls).toEqual(["in:stream:s1", "fetchSockets"]);
  });

  // Resilience: if Redis is briefly unavailable and the adapter
  // throws, presence reporting must degrade to local-only rather
  // than crash the connection handler. The local count is wrong
  // during the outage, but the alternative (uncaught throw inside
  // `disconnecting`) would leak sockets and break leave bookkeeping.
  it("falls back to the local adapter map when fetchSockets throws", async () => {
    const fakeNs = {
      in: () => ({
        fetchSockets: async () => {
          throw new Error("redis is down");
        },
      }),
      adapter: {
        rooms: new Map<string, Set<string>>([
          ["stream:s1", new Set(["sock-a", "sock-b", "sock-c"])],
        ]),
      },
    };
    const n = await getRoomSize(
      fakeNs as unknown as Parameters<typeof getRoomSize>[0],
      "stream:s1",
    );
    expect(n).toBe(3);
  });

  it("returns 0 when the room has no sockets and no local entry", async () => {
    const fakeNs = {
      in: () => ({
        fetchSockets: async () => [] as Array<{ id: string }>,
      }),
      adapter: { rooms: new Map<string, Set<string>>() },
    };
    const n = await getRoomSize(
      fakeNs as unknown as Parameters<typeof getRoomSize>[0],
      "stream:missing",
    );
    expect(n).toBe(0);
  });
});
