import { FastifyInstance } from "fastify";

export default async function tournamentRoutes(fastify: FastifyInstance) {
  // ----------------------------
  // Create new tournament
  // ----------------------------
  fastify.post("/tournament", async (req, reply) => {
    const { name, max_players, admin_id, is_private, password } = req.body as any;

    if (!name || !admin_id) {
      return reply.status(400).send({ success: false, message: "Name and admin_id are required" });
    }

    try {
      const res = await fastify.db.run(
        `INSERT INTO Tournament (name, max_players, is_private, password, admin_id)
         VALUES (?, ?, ?, ?, ?)`,
        [name, max_players ?? 8, is_private ?? 0, password ?? null, admin_id]
      );

      reply.send({ success: true, tournament_id: res.lastID });
    } catch (err) {
      reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

  // ----------------------------
  // Join tournament
  // ----------------------------
  fastify.post("/tournament/join", async (req, reply) => {
    const { tournament_id, user_id, nickname } = req.body as any;

    if (!tournament_id || !user_id) {
      return reply.status(400).send({ success: false, message: "tournament_id and user_id are required" });
    }

    try {
      await fastify.db.run(
        `INSERT INTO Player (user_id, tournament_id, nickname)
         VALUES (?, ?, ?)`,
        [user_id, tournament_id, nickname ?? null]
      );
      reply.send({ success: true });
    } catch (err) {
      reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

  // ----------------------------
  // Get all tournaments
  // ----------------------------
  fastify.get("/tournaments", async (_, reply) => {
    try {
      const tournaments = await fastify.db.all(
        `SELECT t.*, u.username AS admin_username
         FROM Tournament t
         JOIN User u ON t.admin_id = u.id
         ORDER BY t.tournament_id DESC`
      );
      reply.send(tournaments);
    } catch (err) {
      reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

  // ----------------------------
  // Get tournament details including players
  // ----------------------------
  fastify.get("/tournament/:id", async (req, reply) => {
    const { id } = req.params as any;
    try {
      const tournament = await fastify.db.get(
        "SELECT * FROM Tournament WHERE tournament_id = ?",
        [id]
      );

      if (!tournament) return reply.status(404).send({ success: false, message: "Tournament not found" });

      const players = await fastify.db.all(
        `SELECT p.user_id, p.nickname, p.elo, p.rank, u.username
         FROM Player p
         JOIN User u ON p.user_id = u.id
         WHERE p.tournament_id = ?`,
        [id]
      );

      reply.send({ ...tournament, players });
    } catch (err) {
      reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

 fastify.get("/tournament/:id/players", async (req, reply) => {
  const { id } = req.params as any;
  try {
    const players = await fastify.db.all(
      `SELECT p.user_id, p.nickname, p.elo, p.rank, u.username
       FROM Player p
       JOIN User u ON p.user_id = u.id
       WHERE p.tournament_id = ?`,
      [id]
    );
    reply.send(players);
  } catch (err) {
    reply.status(500).send({ success: false, error: (err as Error).message });
  }
});

  // ----------------------------
  // Update tournament status
  // ----------------------------
  fastify.patch("/tournament/:id/status", async (req, reply) => {
    const { id } = req.params as any;
    const { status } = req.body as any;

    if (!["pending", "ongoing", "finished"].includes(status)) {
      return reply.status(400).send({ success: false, message: "Invalid status value" });
    }

    try {
      await fastify.db.run(
        "UPDATE Tournament SET status = ? WHERE tournament_id = ?",
        [status, id]
      );
      reply.send({ success: true });
    } catch (err) {
      reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

  // ----------------------------
  // Delete tournament
  // ----------------------------
  fastify.delete("/tournament/:id", async (req, reply) => {
    const { id } = req.params as any;
    try {
      await fastify.db.run("DELETE FROM Tournament WHERE tournament_id = ?", [id]);
      reply.send({ success: true });
    } catch (err) {
      reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });
}
