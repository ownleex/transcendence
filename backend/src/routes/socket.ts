// backend/src/routes/socket.ts
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Server } from "socket.io";

interface ChatMessage {
  from: number;
  text: string;
  at: string;
}

// ✅ Plus d'export de onlineUsers ici
// Tout sera stocké dans fastify.decorate("onlineUsers", ...)

export const setupSocket = fp(async (fastify: FastifyInstance) => {
  const io = new Server(fastify.server, {
    cors: {
      origin: process.env.CORS_ORIGIN || "*",
      credentials: true,
    },
  });

  // On crée une Map pour les users en ligne et on la stocke dans fastify
  const onlineUsers = new Map<number, string>();
  (fastify as any).io = io;
  (fastify as any).onlineUsers = onlineUsers;
    // Expose helper to look up username by id if db is present (cached)
  const usernameCache = new Map<number, string>();
  (fastify as any).lookupUsername = async (userId: number) => {
    if (usernameCache.has(userId)) return usernameCache.get(userId)!;
    try {
      const row = await fastify.db.get('SELECT username FROM "User" WHERE id = ?', [userId]);
      const name = row?.username || `User ${userId}`;
      usernameCache.set(userId, name);
      return name;
    } catch {
      const name = `User ${userId}`;
      usernameCache.set(userId, name);
      return name;
    }
  };

  io.on("connection", async (socket) => {
    let userId: number | null = null;

    // --- Auth via JWT ---
      try {
      
      const token =
        (socket.handshake.auth && (socket.handshake.auth as any).token) ||
        (typeof socket.handshake.headers.authorization === "string"
          ? socket.handshake.headers.authorization.replace("Bearer ", "")
          : null);      
      if (!token) {
        socket.disconnect(true);
        return;
      }

      const decoded = await (fastify as any).jwt.verify(token);
      userId = decoded.id || decoded.userId || decoded.sub;
      
      if (!userId) {
        socket.disconnect(true);
        return;
      }
      // store username for chat reuse
      try {
        const row = await fastify.db.get('SELECT username FROM "User" WHERE id = ?', [userId]);
        socket.data.username = row?.username || `User ${userId}`;
      } catch {
        socket.data.username = `User ${userId}`;
      }
    } catch (err) {
      fastify.log.error({ err }, "Socket auth failed");
      socket.disconnect(true);
      return;
    }

    // --- Gestion des users en ligne ---
    onlineUsers.set(userId, socket.id);
    (socket as any).data.userId = userId;
    io.emit("user:online", { userId });
    fastify.log.info({ userId }, "Socket connected");

   // helper to know if blocked (either direction)
   const isBlocked = async (a: number, b: number) => {
      try {
        const row = await fastify.db.get(
          `SELECT 1 FROM Friend 
           WHERE status='blocked' AND 
           ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?))`,
          [a, b, b, a]
        );
        return !!row;
      } catch {
        return false;
      }
    };

    // --- Chat lié au match ---
    socket.on("joinMatchChat", (matchId: number) => {
      if (!matchId) return;
      const room = `match_${matchId}`;
      socket.join(room);
      fastify.log.info({ userId, matchId }, "Joined match chat");
    });
    
    socket.on(
      "chat:message",
      async (payload: { matchId: number; text: string }) => {
        if (!payload || !payload.matchId || !payload.text) return;

        const room = `match_${payload.matchId}`;
        let fromUsername = socket.data.username as string | undefined;
        if (!fromUsername) {
          try {
            const row = await fastify.db.get('SELECT username FROM "User" WHERE id = ?', [userId]);
            fromUsername = row?.username;
          } catch {
            /* noop */
          }
        }
        if (!fromUsername) fromUsername = `User ${userId}`;

        const msg: ChatMessage & { fromUsername?: string } = {
          from: userId!,
          text: payload.text.toString().slice(0, 500),
          at: new Date().toISOString(),
          fromUsername,
        };

        const recipients = await io.in(room).fetchSockets();
        for (const s of recipients) {
          const otherId = (s as any).data?.userId || s.handshake.auth?.userId;
          if (!otherId) {
            io.to(s.id).emit("chat:message", msg);
            continue;
          }
          if (await isBlocked(userId!, Number(otherId))) {
            continue;
          }
          io.to(s.id).emit("chat:message", msg);
        }
      }
    );
   
    // retourner les amis en ligne
    socket.on("get:onlineFriends", (friendsIds: number[]) => {
    if (!Array.isArray(friendsIds)) return;
    const online = friendsIds.filter(id => onlineUsers.has(id));

    // Send the list back only to the requester
    socket.emit("onlineFriends", online);
    });
      // --- Friend Accepted Event (new) ---
      socket.on("friend:accepted", async (payload: { senderId: number; receiverId: number }) => {
          const { senderId, receiverId } = payload;

          // Notify sender
          const senderSocketId = onlineUsers.get(senderId);
          if (senderSocketId) {
              io.to(senderSocketId).emit("friend:accepted", { userId: receiverId });
          }

          // Notify receiver
          const receiverSocketId = onlineUsers.get(receiverId);
          if (receiverSocketId) {
              io.to(receiverSocketId).emit("friend:accepted", { userId: senderId });
          }

          fastify.log.info({ senderId, receiverId }, "Friend accepted event emitted to both users");
      });
    // --- Déconnexion ---
    socket.on("disconnect", () => {
      onlineUsers.delete(userId!);
      io.emit("user:offline", { userId });
      fastify.log.info({ userId }, "Socket disconnected");
    });
  });
});
