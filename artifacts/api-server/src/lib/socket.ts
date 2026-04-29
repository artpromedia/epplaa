import { Server as SocketServer, type Namespace, type Socket } from "socket.io";
import type { Server as HttpServer } from "node:http";
import { verifyToken } from "@clerk/backend";
import IORedis, { type Redis as RedisClient } from "ioredis";
import { createAdapter } from "@socket.io/redis-adapter";
import { logger } from "./logger";
import { db, schema } from "./db";
import { eq, sql } from "drizzle-orm";
import {
  chatSendAtomic,
  softDeleteMessage,
  toPublicChatMessage,
} from "./chat";
import { canModerateStream } from "./streamModerators";
import { enqueueReaction, REACTION_BUCKET_MS, startReactionFlusher } from "./reactions";
import { recordAudit } from "./audit";

// Multi-instance Socket.IO. Rooms = `stream:{id}`. Anonymous sockets
// can join (for presence); write events require a verified Clerk JWT.
//
// When `REDIS_URL` is set, sockets are bridged across api-server
// replicas via the @socket.io/redis-adapter pub/sub adapter, and
// per-room presence is computed cluster-wide via `fetchSockets`. This
// is what lets two instances share one chat room and one viewer count.
//
// Without `REDIS_URL` we fall back to the in-process adapter so local
// dev still works against a single replica.
interface AuthedSocket extends Socket {
  data: {
    userId?: string;
    username?: string;
    joinedStreams: Set<string>;
  };
}

let io: SocketServer | null = null;
let redisPub: RedisClient | null = null;
let redisSub: RedisClient | null = null;

export function getSocketServer(): SocketServer | null {
  return io;
}

/**
 * Persist a viewer-count delta for a stream so the trending recommender
 * sees real signal. Extracted from the socket handlers so the same code
 * path can be unit-tested and reused if we ever add a non-WS presence
 * source (HLS heartbeats, stream-key probes, etc.).
 *
 * Contract:
 *   - `count` is the current room size as observed by the caller
 *     (i.e. AFTER the joining socket joined the room, or AFTER the
 *     leaving socket was evicted / minus one if not yet evicted).
 *   - `kind === "join"` also bumps `peak_viewers` monotonically via
 *     `GREATEST(peak_viewers, count)` so the all-time-session peak is
 *     captured even if `current_viewers` later drops.
 *   - `kind === "leave"` only writes `current_viewers`; peak never
 *     decreases.
 *
 * Errors are logged but never thrown — presence is a best-effort
 * signal; we must not fail a chat join because of a flaky DB write.
 */
export async function applyPresenceUpdate(
  streamId: string,
  count: number,
  kind: "join" | "leave",
): Promise<void> {
  try {
    if (kind === "join") {
      await db
        .update(schema.streamsTable)
        .set({
          currentViewers: count,
          peakViewers: sql`GREATEST(${schema.streamsTable.peakViewers}, ${count})`,
        })
        .where(eq(schema.streamsTable.id, streamId));
    } else {
      await db
        .update(schema.streamsTable)
        .set({ currentViewers: count })
        .where(eq(schema.streamsTable.id, streamId));
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, streamId, kind },
      kind === "join" ? "presence_update_failed" : "presence_leave_failed",
    );
  }
}

async function resolveUsername(userId: string): Promise<string> {
  try {
    const [u] = await db
      .select({ name: schema.usersTable.displayName })
      .from(schema.usersTable)
      .where(eq(schema.usersTable.clerkId, userId))
      .limit(1);
    const n = (u?.name ?? "").trim();
    return n.length > 0 ? n : "viewer";
  } catch {
    return "viewer";
  }
}

// Cluster-wide room size. With the Redis adapter wired up,
// `fetchSockets()` walks every replica's adapter so we get one
// global viewer count, not the per-instance count from
// `adapter.rooms.get(room).size`.
export async function getRoomSize(
  ns: Namespace,
  room: string,
): Promise<number> {
  try {
    const sockets = await ns.in(room).fetchSockets();
    return sockets.length;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, room },
      "presence_fetch_sockets_failed_falling_back_to_local",
    );
    return ns.adapter.rooms.get(room)?.size ?? 0;
  }
}

interface RedisAdapterClients {
  pub: RedisClient;
  sub: RedisClient;
}

// Builds the Redis pub/sub client pair the adapter needs. Exported
// for testing; the production wiring just calls into this from
// `bootstrapSocketServer`.
export function createRedisAdapterClients(url: string): RedisAdapterClients {
  const pub = new IORedis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  pub.on("error", (err) => {
    logger.error({ err: err.message }, "socket_redis_pub_error");
  });
  const sub = pub.duplicate();
  sub.on("error", (err) => {
    logger.error({ err: err.message }, "socket_redis_sub_error");
  });
  return { pub, sub };
}

export function bootstrapSocketServer(httpServer: HttpServer): SocketServer {
  if (io) return io;
  io = new SocketServer(httpServer, {
    path: "/api/socket.io",
    cors: { origin: true, credentials: true },
  });

  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) {
    const { pub, sub } = createRedisAdapterClients(redisUrl);
    redisPub = pub;
    redisSub = sub;
    io.adapter(createAdapter(pub, sub));
    logger.info({ adapter: "redis" }, "socket_io_adapter_configured");
  } else {
    logger.warn(
      { adapter: "memory" },
      "socket_io_adapter_in_memory_single_instance_only",
    );
  }

  const ns = io.of("/streams");

  ns.use(async (socket: AuthedSocket, next) => {
    socket.data.joinedStreams = new Set<string>();
    const auth = (socket.handshake.auth ?? {}) as { token?: string };
    const token = typeof auth.token === "string" ? auth.token.trim() : "";
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!token || !secretKey) return next();
    try {
      const payload = await verifyToken(token, { secretKey });
      const sub = typeof payload?.sub === "string" ? payload.sub : "";
      if (sub) {
        socket.data.userId = sub;
        socket.data.username = await resolveUsername(sub);
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "socket_token_verify_failed");
    }
    return next();
  });

  ns.on("connection", async (socket: AuthedSocket) => {
    socket.on("join", async (payload: { streamId?: string } | undefined) => {
      const streamId = String(payload?.streamId ?? "").trim();
      if (!streamId) return;
      const room = `stream:${streamId}`;
      await socket.join(room);
      socket.data.joinedStreams.add(streamId);
      const count = await getRoomSize(ns, room);
      await applyPresenceUpdate(streamId, count, "join");
      ns.to(room).emit("presence:count", { streamId, count });
    });

    socket.on("leave", async (payload: { streamId?: string } | undefined) => {
      const streamId = String(payload?.streamId ?? "").trim();
      if (!streamId) return;
      await leaveStream(socket, streamId);
    });

    socket.on(
      "chat:send",
      async (
        payload: { streamId?: string; text?: string } | undefined,
        ack?: (resp: { ok: boolean; reason?: string; message?: unknown }) => void,
      ) => {
        try {
          const userId = socket.data.userId;
          if (!userId) {
            ack?.({ ok: false, reason: "unauthorized" });
            return;
          }
          const streamId = String(payload?.streamId ?? "").trim();
          const raw = String(payload?.text ?? "").trim();
          if (!streamId || !raw) {
            ack?.({ ok: false, reason: "bad_request" });
            return;
          }
          const text = raw.slice(0, 280);
          const username = socket.data.username ?? "viewer";
          const result = await chatSendAtomic({ streamId, userId, username, text });
          if (!result.ok) {
            if (result.reason === "slow_mode") {
              ack?.({ ok: false, reason: `slow_mode_${result.waitSeconds}` });
            } else {
              ack?.({ ok: false, reason: result.reason });
            }
            return;
          }
          const pub = toPublicChatMessage(result.message);
          ns.to(`stream:${streamId}`).emit("chat:message", pub);
          ack?.({ ok: true, message: pub });
        } catch (err) {
          logger.error({ err: (err as Error).message }, "chat_send_failed");
          ack?.({ ok: false, reason: "internal" });
        }
      },
    );

    socket.on(
      "chat:delete",
      async (
        payload: { streamId?: string; messageId?: string } | undefined,
        ack?: (resp: { ok: boolean; reason?: string }) => void,
      ) => {
        try {
          const userId = socket.data.userId;
          if (!userId) {
            ack?.({ ok: false, reason: "unauthorized" });
            return;
          }
          const streamId = String(payload?.streamId ?? "").trim();
          const messageId = String(payload?.messageId ?? "").trim();
          if (!streamId || !messageId) {
            ack?.({ ok: false, reason: "bad_request" });
            return;
          }
          // Hosts and per-stream mods may both delete messages.
          if (!(await canModerateStream(streamId, userId))) {
            ack?.({ ok: false, reason: "forbidden" });
            return;
          }
          const ok = await softDeleteMessage(streamId, messageId, userId);
          if (!ok) {
            ack?.({ ok: false, reason: "not_found" });
            return;
          }
          ns.to(`stream:${streamId}`).emit("chat:deleted", { streamId, messageId });
          await recordAudit({
            actorId: userId,
            action: "stream.chat.delete",
            entity: "streamChatMessage",
            entityId: messageId,
            payload: { streamId },
          });
          ack?.({ ok: true });
        } catch (err) {
          logger.error({ err: (err as Error).message }, "chat_delete_failed");
          ack?.({ ok: false, reason: "internal" });
        }
      },
    );

    socket.on(
      "reaction:add",
      async (
        payload: { streamId?: string; kind?: string; count?: number } | undefined,
        ack?: (resp: { ok: boolean }) => void,
      ) => {
        try {
          const userId = socket.data.userId;
          if (!userId) {
            ack?.({ ok: false });
            return;
          }
          const streamId = String(payload?.streamId ?? "").trim();
          if (!streamId) {
            ack?.({ ok: false });
            return;
          }
          const kind = String(payload?.kind ?? "heart").slice(0, 16);
          const count = Math.max(1, Math.min(10, Number(payload?.count ?? 1)));
          enqueueReaction(streamId, kind, count);
          ack?.({ ok: true });
        } catch (err) {
          logger.error({ err: (err as Error).message }, "reaction_add_failed");
          ack?.({ ok: false });
        }
      },
    );

    // `disconnecting` (not `disconnect`) so socket.rooms still contains the
    // joined rooms when we recompute presence.
    socket.on("disconnecting", async () => {
      const ids = new Set<string>(socket.data.joinedStreams);
      for (const room of socket.rooms) {
        if (room.startsWith("stream:")) ids.add(room.slice("stream:".length));
      }
      for (const streamId of ids) {
        await leaveStream(socket, streamId, /* alreadyInRoom */ true);
      }
    });
  });

  startReactionFlusher((streamId, kind, count) => {
    // With the Redis adapter, this `to(...).emit(...)` reaches viewers
    // on every replica, not just sockets connected to this process.
    ns.to(`stream:${streamId}`).emit("reaction:burst", { streamId, kind, count });
  });

  logger.info({ bucketMs: REACTION_BUCKET_MS }, "socket_io_bootstrapped");
  return io;
}

async function leaveStream(socket: AuthedSocket, streamId: string, alreadyInRoom = false): Promise<void> {
  if (!io) return;
  const ns = io.of("/streams");
  const room = `stream:${streamId}`;
  if (!alreadyInRoom) {
    await socket.leave(room);
  }
  socket.data.joinedStreams.delete(streamId);
  // disconnecting fires before socket.io evicts the socket, so the
  // cluster-wide count still includes this socket; subtract 1 in
  // that case to report the post-disconnect total.
  const raw = await getRoomSize(ns, room);
  const count = alreadyInRoom ? Math.max(0, raw - 1) : raw;
  await applyPresenceUpdate(streamId, count, "leave");
  ns.to(room).emit("presence:count", { streamId, count });
}

export async function shutdownSocketServer(): Promise<void> {
  if (io) {
    await io.close();
    io = null;
  }
  const closes: Promise<unknown>[] = [];
  if (redisPub) {
    closes.push(redisPub.quit().catch(() => undefined));
    redisPub = null;
  }
  if (redisSub) {
    closes.push(redisSub.quit().catch(() => undefined));
    redisSub = null;
  }
  await Promise.all(closes);
}
