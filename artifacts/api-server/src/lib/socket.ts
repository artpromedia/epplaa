import { Server as SocketServer, type Socket } from "socket.io";
import type { Server as HttpServer } from "node:http";
import { verifyToken } from "@clerk/backend";
import { logger } from "./logger";
import { db, schema } from "./db";
import { eq, sql } from "drizzle-orm";
import {
  chatSendAtomic,
  isHost,
  softDeleteMessage,
  toPublicChatMessage,
} from "./chat";
import { enqueueReaction, REACTION_BUCKET_MS, startReactionFlusher } from "./reactions";
import { recordAudit } from "./audit";

// Single-instance Socket.IO. Rooms = `stream:{id}`. Anonymous sockets
// can join (for presence); write events require a verified Clerk JWT.
interface AuthedSocket extends Socket {
  data: {
    userId?: string;
    username?: string;
    joinedStreams: Set<string>;
  };
}

let io: SocketServer | null = null;

export function getSocketServer(): SocketServer | null {
  return io;
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

export function bootstrapSocketServer(httpServer: HttpServer): SocketServer {
  if (io) return io;
  io = new SocketServer(httpServer, {
    path: "/api/socket.io",
    cors: { origin: true, credentials: true },
  });

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
      const count = ns.adapter.rooms.get(room)?.size ?? 0;
      try {
        await db
          .update(schema.streamsTable)
          .set({
            currentViewers: count,
            peakViewers: sql`GREATEST(${schema.streamsTable.peakViewers}, ${count})`,
          })
          .where(eq(schema.streamsTable.id, streamId));
      } catch (err) {
        logger.error({ err: (err as Error).message, streamId }, "presence_update_failed");
      }
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
          if (!(await isHost(streamId, userId))) {
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
  // disconnecting fires before socket.io evicts the socket; subtract 1.
  const raw = ns.adapter.rooms.get(room)?.size ?? 0;
  const count = alreadyInRoom ? Math.max(0, raw - 1) : raw;
  try {
    await db
      .update(schema.streamsTable)
      .set({ currentViewers: count })
      .where(eq(schema.streamsTable.id, streamId));
  } catch (err) {
    logger.error({ err: (err as Error).message, streamId }, "presence_leave_failed");
  }
  ns.to(room).emit("presence:count", { streamId, count });
}
