import { io, type Socket } from "socket.io-client";

/**
 * Single shared Socket.IO connection to the /streams namespace.
 *
 * Auth payload sends a fresh Clerk session JWT as `auth.token`. The
 * server verifies the token and resolves the user identity from its
 * own users table — we never trust client-asserted userId/username
 * (otherwise hosts could be impersonated for moderation actions).
 *
 * The token getter is registered once by ApiAuthBridge after Clerk has
 * loaded; calling `setSocketTokenGetter(null)` (or signing out) drops
 * the socket back to anonymous read-only mode.
 */

let socket: Socket | null = null;
let getTokenFn: (() => Promise<string | null>) | null = null;

export function setSocketTokenGetter(fn: (() => Promise<string | null>) | null) {
  getTokenFn = fn;
  if (socket) {
    // Force a reconnect so the new token is sent in the handshake.
    if (socket.connected) socket.disconnect();
    socket.connect();
  }
}

export function connectStreamSocket(): Socket {
  if (socket && socket.connected) return socket;
  if (!socket) {
    socket = io("/streams", {
      path: "/api/socket.io",
      transports: ["websocket", "polling"],
      // socket.io supports an async function for `auth` — it's invoked
      // before every (re)connection attempt, so the token stays fresh
      // across Clerk's automatic JWT rotation.
      auth: async (cb: (data: Record<string, string>) => void) => {
        try {
          const token = getTokenFn ? await getTokenFn() : null;
          cb({ token: token ?? "" });
        } catch {
          cb({ token: "" });
        }
      },
    });
  } else if (!socket.connected) {
    socket.connect();
  }
  return socket;
}

export function disconnectStreamSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
