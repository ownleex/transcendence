import { FastifyInstance } from "fastify";

export default async function notificationRoutes(fastify: FastifyInstance) {
  fastify.get("/notifications/:userId", async (req, reply) => {
    const { userId } = req.params as any;
    const notifs = await fastify.db.all(
      "SELECT * FROM Notification WHERE owner_id = ? ORDER BY notif_id DESC",
      [userId]
    );
    reply.send(notifs);
  });
}
