import { FastifyInstance } from "fastify";

export default async function statsRoutes(fastify: FastifyInstance) {
  // Leaderboard by ELO
  fastify.get("/leaderboard", async (_, reply) => {
    const leaderboard = await fastify.db.all(`
      SELECT U.username, S.elo, S.matches_played, S.winrate
      FROM UserStats S
      JOIN User U ON U.id = S.user_id
      ORDER BY S.elo DESC
      LIMIT 20
    `);
    reply.send(leaderboard);
  });

  // Get stats for specific user
  fastify.get("/stats/:id", async (req, reply) => {
    const { id } = req.params as any;
    const stats = await fastify.db.get(
      "SELECT * FROM UserStats WHERE user_id = ?",
      [id]
    );
    reply.send(stats ?? {});
  });
}
