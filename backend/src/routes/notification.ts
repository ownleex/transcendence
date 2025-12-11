import { FastifyInstance } from "fastify";

export default async function notificationRoutes(fastify: FastifyInstance) {
    fastify.get("/notifications/:userId", async (req, reply) => {
        const { userId } = req.params as any;

        try {
            const notifs = await fastify.db.all(
                "SELECT * FROM Notification WHERE owner_id = ? ORDER BY notif_id DESC",
                [userId]
            );

            reply.send({ success: true, notifications: notifs });
        } catch (err: any) {
            reply.code(500).send({ success: false, error: err.message });
        }
    });
}
