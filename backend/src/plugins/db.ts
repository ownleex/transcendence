// backend/src/plugins/db.ts
import fp from "fastify-plugin";
import { initDB } from "../db/index";

export default fp(async (fastify) => {
  const db = await initDB();
  fastify.decorate("db", db);

  fastify.addHook("onClose", async (FastifyInstance) => {
    await db.close();
    fastify.log.info("🗄️ Database connection closed.");
  });
});
