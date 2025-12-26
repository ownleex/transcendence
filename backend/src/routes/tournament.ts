import { FastifyInstance } from "fastify";
import { blockchainService } from "../services/blockchain";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { createDirectMatch, isMatchActive, matchHasPlayers, removeMatch } from "../ws/game";

type DB = any;

async function ensureMatchSchema(db: DB) {
  const cols = await db.all(`PRAGMA table_info("Match")`);
  const names = cols.map((c: any) => c.name);
  if (!names.includes("round")) {
    await db.run(`ALTER TABLE "Match" ADD COLUMN round TEXT`);
  }
  if (!names.includes("slot")) {
    await db.run(`ALTER TABLE "Match" ADD COLUMN slot INTEGER`);
  }
  if (!names.includes("score1")) {
    await db.run(`ALTER TABLE "Match" ADD COLUMN score1 INTEGER`);
  }
  if (!names.includes("score2")) {
    await db.run(`ALTER TABLE "Match" ADD COLUMN score2 INTEGER`);
  }
}

async function ensureTournamentSchema(db: DB) {
  const cols = await db.all(`PRAGMA table_info("Tournament")`);
  const names = cols.map((c: any) => c.name);
  if (!names.includes("WinnerAvatar")) {
    await db.run(`ALTER TABLE "Tournament" ADD COLUMN WinnerAvatar TEXT`);
  }
  if (!names.includes("mode")) {
    await db.run(`ALTER TABLE "Tournament" ADD COLUMN mode TEXT DEFAULT 'online'`);
  }
  if (!names.includes("BlockchainBlockNumber")) {
    await db.run(`ALTER TABLE "Tournament" ADD COLUMN BlockchainBlockNumber INTEGER`);
  }
  if (!names.includes("BlockchainTxHash")) {
    await db.run(`ALTER TABLE "Tournament" ADD COLUMN BlockchainTxHash TEXT`);
  }
  if (!names.includes("BlockchainExplorerUrl")) {
    await db.run(`ALTER TABLE "Tournament" ADD COLUMN BlockchainExplorerUrl TEXT`);
  }
  if (!names.includes("BlockchainContractUrl")) {
    await db.run(`ALTER TABLE "Tournament" ADD COLUMN BlockchainContractUrl TEXT`);
  }
}

async function fetchTournamentPlayers(db: DB, tournamentId: number) {
  return db.all(
    `SELECT p.player_id, p.user_id, COALESCE(p.nickname, u.username) as displayName, u.username, u.avatar
     FROM Player p
     JOIN User u ON p.user_id = u.id
     WHERE p.tournament_id = ?`,
    [tournamentId]
  );
}

async function generateQuarterBracket(db: DB, tournamentId: number) {
  await ensureMatchSchema(db);
  const players = await fetchTournamentPlayers(db, tournamentId);
  if (players.length !== 8) {
    throw new Error("Tournament needs exactly 8 players to start");
  }

  // Reset previous matches for this tournament
  await db.run(`DELETE FROM Match WHERE tournament_id = ?`, [tournamentId]);

  // Shuffle players
  const shuffled = [...players].sort(() => Math.random() - 0.5);

  for (let i = 0; i < 4; i++) {
    const p1 = shuffled[i * 2];
    const p2 = shuffled[i * 2 + 1];
    await db.run(
      `INSERT INTO Match (player1, player2, tournament_id, round, slot) VALUES (?, ?, ?, 'quarter', ?)`,
      [p1.player_id, p2.player_id, tournamentId, i + 1]
    );
  }

  await db.run(`UPDATE Tournament SET status = 'ongoing' WHERE tournament_id = ?`, [tournamentId]);
}

async function resolvePlayerName(db: DB, playerId: number) {
  const row = await db.get(
    `SELECT COALESCE(p.nickname, u.username) as name, u.avatar
     FROM Player p
     JOIN User u ON p.user_id = u.id
     WHERE p.player_id = ?`,
    [playerId]
  );
  return { name: row?.name ?? `Player ${playerId}`, avatar: row?.avatar ?? null };
}

async function persistBlockchainResult(db: DB, tournamentId: number, blockchainResult: any) {
  if (!blockchainResult) return;
  await db.run(
    `UPDATE Tournament 
       SET BlockchainBlockNumber = ?, 
           BlockchainTxHash = ?, 
           BlockchainExplorerUrl = ?, 
           BlockchainContractUrl = ?
     WHERE tournament_id = ?`,
    [
      blockchainResult.blockNumber ?? null,
      blockchainResult.txHash ?? null,
      blockchainResult.explorerUrl ?? null,
      blockchainResult.contractUrl ?? null,
      tournamentId,
    ]
  );
}

async function recordTournamentMatch(db: DB, player1Id: number, player2Id: number, score1: number, score2: number) {
  const p1 = await db.get(`SELECT user_id FROM Player WHERE player_id = ?`, [player1Id]);
  const p2 = await db.get(`SELECT user_id FROM Player WHERE player_id = ?`, [player2Id]);
  if (!p1?.user_id || !p2?.user_id) return;

  const user1 = p1.user_id as number;
  const user2 = p2.user_id as number;
  const s1 = Number.isFinite(score1) ? score1 : 0;
  const s2 = Number.isFinite(score2) ? score2 : 0;

  // Ensure stats rows exist
  await db.run(`INSERT OR IGNORE INTO "UserStats" (user_id) VALUES (?)`, [user1]);
  await db.run(`INSERT OR IGNORE INTO "UserStats" (user_id) VALUES (?)`, [user2]);

  const stats1 = await db.get(`SELECT elo FROM "UserStats" WHERE user_id = ?`, [user1]);
  const stats2 = await db.get(`SELECT elo FROM "UserStats" WHERE user_id = ?`, [user2]);
  const elo1 = stats1?.elo ?? 1000;
  const elo2 = stats2?.elo ?? 1000;

  // ELO update
  const expected1 = 1 / (1 + Math.pow(10, (elo2 - elo1) / 400));
  const expected2 = 1 - expected1;
  const result1 = s1 === s2 ? 0.5 : s1 > s2 ? 1 : 0;
  const result2 = 1 - result1;
  const K = 32;
  const newElo1 = Math.round(elo1 + K * (result1 - expected1));
  const newElo2 = Math.round(elo2 + K * (result2 - expected2));

  await db.run(
    `INSERT INTO "MatchHistory" (user_id, opponent_id, user_score, opponent_score, user_elo, result)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [user1, user2, s1, s2, newElo1, s1 > s2 ? "win" : s1 < s2 ? "loss" : "draw"]
  );
  await db.run(
    `INSERT INTO "MatchHistory" (user_id, opponent_id, user_score, opponent_score, user_elo, result)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [user2, user1, s2, s1, newElo2, s2 > s1 ? "win" : s2 < s1 ? "loss" : "draw"]
  );

  // Update aggregate stats
  for (const uid of [user1, user2]) {
    const totalRow = await db.get(`SELECT COUNT(*) as total FROM "MatchHistory" WHERE user_id = ?`, [uid]);
    const winsRow = await db.get(`SELECT COUNT(*) as wins FROM "MatchHistory" WHERE user_id = ? AND result = 'win'`, [uid]);
    const total = totalRow?.total || 0;
    const wins = winsRow?.wins || 0;
    const winrate = total > 0 ? (wins / total) * 100 : 0;
    const elo = uid === user1 ? newElo1 : newElo2;
    await db.run(
      `INSERT INTO "UserStats" (user_id, matches_played, winrate, elo) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET matches_played=excluded.matches_played, winrate=excluded.winrate, elo=excluded.elo`,
      [uid, total, winrate, elo]
    );
  }
}

async function progressBracket(fastify: FastifyInstance, tournamentId: number) {
  const db = (fastify as any).db;
  await ensureMatchSchema(db);
  let blockchainResult: any | undefined;

  // 1. Récupération de TOUS les matchs (y compris les potentiels doublons)
  let matches = await db.all(
    `SELECT m.*
     FROM Match m
     WHERE m.tournament_id = ?
     ORDER BY 
       CASE m.round WHEN 'quarter' THEN 1 WHEN 'semi' THEN 2 ELSE 3 END,
       m.slot`,
    [tournamentId]
  );

  // --- DÉBUT BLOC NETTOYAGE (SANITIZATION) ---
  const uniqueMatchesMap = new Map<string, any>();
  const idsToDelete: number[] = [];

  for (const m of matches) {
    const key = `${m.round}-${m.slot}`; // Ex: "semi-1", "final-1"

    if (!uniqueMatchesMap.has(key)) {
      uniqueMatchesMap.set(key, m);
    } else {
      // CONFLIT DÉTECTÉ : On a déjà un match pour ce slot !
      const existing = uniqueMatchesMap.get(key);

      // On décide lequel garder :
      // Priorité à celui qui a un 'winner' défini. Sinon, on garde le plus ancien (ID plus petit).
      let keepCurrent = false;
      if (m.winner && !existing.winner) {
          keepCurrent = true;
      } else if (!m.winner && existing.winner) {
          keepCurrent = false;
      } else {
          // Si égalité (les deux ont un winner ou aucun n'en a), on garde le premier créé (ID min)
          if (m.match_id < existing.match_id) keepCurrent = true;
      }

      if (keepCurrent) {
        // On supprime l'ancien de la map et on ajoute à la liste de suppression
        idsToDelete.push(existing.match_id);
        uniqueMatchesMap.set(key, m);
      } else {
        // On supprime le nouveau (doublon inutile)
        idsToDelete.push(m.match_id);
      }
    }
  }

  // Suppression effective des doublons en base de données
  if (idsToDelete.length > 0) {
    // On le fait en parallèle pour gagner du temps
    await Promise.all(idsToDelete.map(id => db.run(`DELETE FROM Match WHERE match_id = ?`, [id])));
    console.log(`🧹 Nettoyage terminé : ${idsToDelete.length} matchs doublons supprimés pour le tournoi ${tournamentId}.`);
  }

  // On travaille maintenant avec la liste PROPRE
  matches = Array.from(uniqueMatchesMap.values());
  // --- FIN BLOC NETTOYAGE ---

  const quarters = matches.filter((m: any) => m.round === "quarter");
  const semis = matches.filter((m: any) => m.round === "semi");
  const finalMatch = matches.find((m: any) => m.round === "final");

  const qWinners = new Map<number, number>();
  quarters.forEach((q: any) => {
    if (q.winner && q.slot) qWinners.set(Number(q.slot), q.winner);
  });

  const createOrUpdateSemi = async (slot: number, fromSlots: [number, number]) => {
    const p1 = qWinners.get(fromSlots[0]);
    const p2 = qWinners.get(fromSlots[1]);
    if (!p1 || !p2) return;

    // Ici, grâce au nettoyage plus haut, 'existing' est garanti unique ou inexistant dans 'matches'
    // Mais on garde la vérif DB au cas où
    let existing = semis.find((s: any) => Number(s.slot) === slot);

    if (!existing) {
        const doubleCheck = await db.get(
            `SELECT * FROM Match WHERE tournament_id = ? AND round = 'semi' AND slot = ?`,
            [tournamentId, slot]
        );
        if (doubleCheck) existing = doubleCheck;
    }

    if (existing) {
      const shouldResetWinner = existing.player1 !== p1 || existing.player2 !== p2;
      if (shouldResetWinner || existing.player1 !== p1 || existing.player2 !== p2) {
          await db.run(
            `UPDATE Match SET player1 = ?, player2 = ?, winner = CASE WHEN ? THEN NULL ELSE winner END WHERE match_id = ?`,
            [p1, p2, shouldResetWinner ? 1 : 0, existing.match_id]
          );
      }
    } else {
      const res = await db.run(
        `INSERT INTO Match (player1, player2, tournament_id, round, slot) VALUES (?, ?, ?, 'semi', ?)`,
        [p1, p2, tournamentId, slot]
      );
      semis.push({ match_id: res.lastID, player1: p1, player2: p2, round: "semi", slot, tournament_id: tournamentId });
    }
  };

  await createOrUpdateSemi(1, [1, 2]);
  await createOrUpdateSemi(2, [3, 4]);

  const semiWinners = new Map<number, number>();
  semis.forEach((s: any) => {
    if (s.winner && s.slot) semiWinners.set(Number(s.slot), s.winner);
  });

  if (semiWinners.has(1) && semiWinners.has(2)) {
    const p1 = semiWinners.get(1)!;
    const p2 = semiWinners.get(2)!;
    
    // Même logique : on nettoie d'abord en mémoire via 'finalMatch' (unique via le clean du haut)
    let effectiveFinal = finalMatch; 
    
    if (!effectiveFinal) {
         const doubleCheckFinal = await db.get(
            `SELECT * FROM Match WHERE tournament_id = ? AND round = 'final'`,
            [tournamentId]
        );
        if (doubleCheckFinal) effectiveFinal = doubleCheckFinal;
    }

    if (effectiveFinal) {
      const resetWinner = effectiveFinal.player1 !== p1 || effectiveFinal.player2 !== p2;
      if (resetWinner || effectiveFinal.player1 !== p1) {
          await db.run(
            `UPDATE Match SET player1 = ?, player2 = ?, winner = CASE WHEN ? THEN NULL ELSE winner END WHERE match_id = ?`,
            [p1, p2, resetWinner ? 1 : 0, effectiveFinal.match_id]
          );
      }
    } else {
      await db.run(
        `INSERT INTO Match (player1, player2, tournament_id, round, slot) VALUES (?, ?, ?, 'final', 1)`,
        [p1, p2, tournamentId]
      );
    }
  }

  // Vérification de la fin du tournoi et Blockchain
  // On refait un petit select pour être sûr d'avoir l'état le plus frais après nos updates
  const updatedFinal = await db.get(
    `SELECT * FROM Match WHERE tournament_id = ? AND round = 'final' LIMIT 1`,
    [tournamentId]
  );

  if (updatedFinal?.winner) {
    const winnerData = await resolvePlayerName(db, updatedFinal.winner);
    const winnerName = winnerData?.name;
    const winnerAvatar = winnerData?.avatar;
    
    const currentStatusRow = await db.get(`SELECT status FROM Tournament WHERE tournament_id = ?`, [tournamentId]);
    
    if (currentStatusRow?.status !== 'finished') {
        await db.run(
          `UPDATE Tournament SET status = 'finished', WinnerId = ?, WinnerName = ?, WinnerAvatar = ? WHERE tournament_id = ?`,
          [updatedFinal.winner, winnerName, winnerAvatar, tournamentId]
        );

        const tournamentRow = await db.get(`SELECT name FROM Tournament WHERE tournament_id = ?`, [tournamentId]);
        if (tournamentRow?.name && winnerName) {
          try {
            blockchainResult = await blockchainService.recordTournament(tournamentRow.name, winnerName, 8);
            await persistBlockchainResult(db, tournamentId, blockchainResult);
          } catch (err) {
            fastify.log.error({ err }, "Failed to push tournament result to blockchain");
          }
        }
    }
  }

  return blockchainResult;
}

export default async function tournamentRoutes(fastify: FastifyInstance) {
  await ensureMatchSchema((fastify as any).db);
  await ensureTournamentSchema((fastify as any).db);
  const tournamentReady: Map<number, Set<number>> = (fastify as any).tournamentReady || new Map();
  (fastify as any).tournamentReady = tournamentReady;
  // Map bracket match_id -> live game matchId (to let late listeners join)
  const liveGameMatches: Map<number, { gameId: number; createdAt: number }> = (fastify as any).tournamentLiveMatches || new Map();
  (fastify as any).tournamentLiveMatches = liveGameMatches;
  const creatingLiveMatches: Set<number> = (fastify as any).tournamentLiveCreating || new Set();
  (fastify as any).tournamentLiveCreating = creatingLiveMatches;
  // ----------------------------
  // Create new tournament
  // ----------------------------
  fastify.post("/tournament", async (req, reply) => {
    const { name, max_players, admin_id, is_private, password, mode } = req.body as any;

    if (!name || !admin_id) {
      return reply.status(400).send({ success: false, message: "Name and admin_id are required" });
    }

    try {
      const res = await fastify.db.run(
        `INSERT INTO Tournament (name, max_players, is_private, password, admin_id, mode)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [name, max_players ?? 8, is_private ?? 0, password ?? null, admin_id, mode === "offline" ? "offline" : "online"]
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
      const tournament = await fastify.db.get(`SELECT status FROM Tournament WHERE tournament_id = ?`, [tournament_id]);
      if (!tournament) return reply.status(404).send({ success: false, message: "Tournament not found" });
      if (tournament.status === "finished") {
        return reply.status(400).send({ success: false, message: "Tournament already finished" });
      }

      const exists = await fastify.db.get(
        `SELECT 1 FROM Player WHERE tournament_id = ? AND user_id = ?`,
        [tournament_id, user_id]
      );
      if (exists) {
        const cnt = await fastify.db.get(`SELECT COUNT(*) as cnt FROM Player WHERE tournament_id = ?`, [tournament_id]);
        return reply.send({ success: true, player_count: cnt?.cnt ?? 0 });
      }

      const count = await (fastify as any).db.get(
        `SELECT COUNT(*) as cnt FROM Player WHERE tournament_id = ?`,
        [tournament_id]
      );
      if (count?.cnt >= 8) {
        return reply.status(400).send({ success: false, message: "Tournament is already full (8 players)" });
      }

      await fastify.db.run(
        `INSERT INTO Player (user_id, tournament_id, nickname)
         VALUES (?, ?, ?)`,
        [user_id, tournament_id, nickname ?? null]
      );

      const afterCount = await (fastify as any).db.get(
        `SELECT COUNT(*) as cnt FROM Player WHERE tournament_id = ?`,
        [tournament_id]
      );

      // Autostart bracket when 8 players reached
      if (afterCount?.cnt === 8) {
        await generateQuarterBracket((fastify as any).db, tournament_id);
      }

      reply.send({ success: true, player_count: afterCount?.cnt ?? count?.cnt ?? 0 });
    } catch (err) {
      reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

  // ----------------------------
  // Join tournament using alias only (guest)
  // ----------------------------
  fastify.post("/tournament/join-alias", async (req, reply) => {
    const { tournament_id, alias } = req.body as any;
    const trimmed = (alias || "").trim();
    if (!tournament_id || !trimmed) {
      return reply.status(400).send({ success: false, message: "tournament_id and alias are required" });
    }

    try {
      const tournament = await fastify.db.get(`SELECT status FROM Tournament WHERE tournament_id = ?`, [tournament_id]);
      if (!tournament) return reply.status(404).send({ success: false, message: "Tournament not found" });
      if (tournament.status === "finished") {
        return reply.status(400).send({ success: false, message: "Tournament already finished" });
      }

      const exists = await fastify.db.get(
        `SELECT 1 FROM Player WHERE tournament_id = ? AND nickname = ?`,
        [tournament_id, trimmed]
      );
      if (exists) {
        const cnt = await fastify.db.get(`SELECT COUNT(*) as cnt FROM Player WHERE tournament_id = ?`, [tournament_id]);
        return reply.send({ success: true, player_count: cnt?.cnt ?? 0 });
      }

      const count = await fastify.db.get(
        `SELECT COUNT(*) as cnt FROM Player WHERE tournament_id = ?`,
        [tournament_id]
      );
      if (count?.cnt >= 8) {
        return reply.status(400).send({ success: false, message: "Tournament is already full (8 players)" });
      }

      // Create a lightweight guest user
      const base = trimmed.replace(/\s+/g, "_").toLowerCase().slice(0, 20) || "guest";
      let username = base;
      let suffix = 1;
      while (await fastify.db.get(`SELECT 1 FROM User WHERE username = ?`, [username])) {
        username = `${base}_${suffix++}`;
      }
      const email = `${username}.${Date.now()}@guest.local`;
      const password = crypto.randomBytes(10).toString("hex");
      const hashed = await bcrypt.hash(password, 10);

      const userRes = await fastify.db.run(
        "INSERT INTO User (username, email, password) VALUES (?, ?, ?)",
        [username, email, hashed]
      );
      const userId = userRes.lastID;
      await fastify.db.run("INSERT INTO UserStats (user_id) VALUES (?)", [userId]);

      await fastify.db.run(
        `INSERT INTO Player (user_id, tournament_id, nickname)
         VALUES (?, ?, ?)`,
        [userId, tournament_id, trimmed]
      );

      const afterCount = await fastify.db.get(
        `SELECT COUNT(*) as cnt FROM Player WHERE tournament_id = ?`,
        [tournament_id]
      );

      if (afterCount?.cnt === 8) {
        await generateQuarterBracket((fastify as any).db, tournament_id);
      }

      reply.send({ success: true, player_count: afterCount?.cnt ?? count?.cnt ?? 0, user_id: userId });
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

      const onlineUsers = tournament.mode === "online" ? (fastify as any).onlineUsers as Map<number, string> | undefined : undefined;
      const players = await fastify.db.all(
        `SELECT p.user_id, p.nickname, p.elo, p.rank, u.username, u.avatar
         FROM Player p
         JOIN User u ON p.user_id = u.id
         WHERE p.tournament_id = ?`,
        [id]
      );
      const enriched = players.map((p: any) => ({
        ...p,
        online: onlineUsers ? onlineUsers.has(p.user_id) : false,
      }));

      reply.send({ ...tournament, players: enriched });
    } catch (err) {
      reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

  // ----------------------------
  // Get tournament players
  // ----------------------------
  fastify.get("/tournament/:id/players", async (req, reply) => {
    const { id } = req.params as any;
    try {
      const onlineUsers = (fastify as any).onlineUsers as Map<number, string> | undefined;
      const players = await fastify.db.all(
        `SELECT p.user_id, p.nickname, p.elo, p.rank, u.username, u.avatar
         FROM Player p
         JOIN User u ON p.user_id = u.id
         WHERE p.tournament_id = ?`,
        [id]
      );
      const enriched = players.map((p: any) => ({
        ...p,
        online: onlineUsers ? onlineUsers.has(p.user_id) : false,
      }));
      reply.send(enriched);
    } catch (err) {
      reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

  // ----------------------------
  // Leave tournament
  // ----------------------------
  fastify.post("/tournament/:id/leave", async (req, reply) => {
    const { id } = req.params as any;
    const { user_id } = req.body as any;
    if (!user_id) return reply.status(400).send({ success: false, message: "user_id is required" });
    try {
      await fastify.db.run(`DELETE FROM Player WHERE tournament_id = ? AND user_id = ?`, [id, user_id]);
      reply.send({ success: true });
    } catch (err) {
      reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

  // ----------------------------
  // Player ready for upcoming match (online)
  // ----------------------------
  fastify.post("/tournament/:id/match/:matchId/ready", async (req, reply) => {
    const { id, matchId } = req.params as any;
    const { user_id } = req.body as any;
    if (!user_id) return reply.status(400).send({ success: false, message: "user_id is required" });

    const onlineUsers = (fastify as any).onlineUsers as Map<number, string> | undefined;
    const io = (fastify as any).io;
    const readyMap: Map<number, Set<number>> = (fastify as any).tournamentReady;
    const liveMap: Map<number, { gameId: number; createdAt: number }> = (fastify as any).tournamentLiveMatches;

    try {
      const matchIdNum = Number(matchId);
      const tournamentIdNum = Number(id);
      const tournament = await fastify.db.get(`SELECT mode FROM Tournament WHERE tournament_id = ?`, [id]);
      if (!tournament) return reply.status(404).send({ success: false, message: "Tournament not found" });
      if (tournament.mode === "offline") {
        return reply.status(400).send({ success: false, message: "This tournament is offline-only" });
      }
      const match = await fastify.db.get(
        `SELECT m.*, p1.user_id as u1, p2.user_id as u2
         FROM Match m
         LEFT JOIN Player p1 ON m.player1 = p1.player_id
         LEFT JOIN Player p2 ON m.player2 = p2.player_id
         WHERE m.match_id = ? AND m.tournament_id = ?`,
        [matchIdNum, tournamentIdNum]
      );
      if (!match) return reply.status(404).send({ success: false, message: "Match not found" });
      const participants = [Number(match.u1), Number(match.u2)].filter((v) => Number.isFinite(v));
      const requester = Number(user_id);
      if (!participants.includes(requester)) {
        return reply.status(403).send({ success: false, message: "User not in this match" });
      }
      if (!onlineUsers?.has(requester)) {
        return reply.status(400).send({ success: false, message: "User must be online" });
      }

      // If a live match exists but is stale or wrong, discard it
      const existingLive = liveMap.get(matchIdNum);
      if (existingLive) {
        const tooOld = Date.now() - existingLive.createdAt > 20 * 60 * 1000;
        const active = isMatchActive(existingLive.gameId);
        const correctPlayers = matchHasPlayers(existingLive.gameId, participants);
        if (tooOld || !active || !correctPlayers) {
          removeMatch(existingLive.gameId);
          liveMap.delete(matchIdNum);
        }
      }

      // If match already launched and still valid, return existing gameMatchId so client can join without refresh
      if (liveMap.has(matchIdNum)) {
        return reply.send({ success: true, status: "starting", gameMatchId: liveMap.get(matchIdNum)!.gameId });
      }

      if (!readyMap.has(matchIdNum)) readyMap.set(matchIdNum, new Set());
      readyMap.get(matchIdNum)!.add(requester);

      // Notify both players about readiness update
      for (const uid of participants) {
        const sid = onlineUsers?.get(uid);
        if (sid) {
          io.to(sid).emit("tournament:ready", { tournamentId: tournamentIdNum, matchId: matchIdNum, readyIds: Array.from(readyMap.get(matchIdNum)!) });
        }
      }

      const allReady = participants.every((uid: number) => readyMap.get(matchIdNum)!.has(uid));
      if (!allReady) {
        return reply.send({ success: true, status: "waiting", ready: Array.from(readyMap.get(matchIdNum)!) });
      }

      // Both ready: create direct match for online play
      if (liveMap.has(matchIdNum)) {
        return reply.send({ success: true, status: "starting", gameMatchId: liveMap.get(matchIdNum)!.gameId });
      }
      if (creatingLiveMatches.has(matchIdNum)) {
        return reply.send({ success: true, status: "starting" });
      }
      creatingLiveMatches.add(matchIdNum);
      const mode: 2 | 4 = 2;
      const staleLive = liveMap.get(matchIdNum);
      if (staleLive) {
        removeMatch(staleLive.gameId);
      }
      let matchIdGame: number;
      try {
        matchIdGame = createDirectMatch([match.u1, match.u2], mode);
        readyMap.delete(matchIdNum);
        liveMap.set(matchIdNum, { gameId: matchIdGame, createdAt: Date.now() });
      } finally {
        creatingLiveMatches.delete(matchIdNum);
      }

      for (const uid of participants) {
        const sid = onlineUsers?.get(uid);
        if (sid) {
          io.to(sid).emit("tournament:match:start", {
            tournamentId: tournamentIdNum,
            bracketMatchId: matchIdNum,
            gameMatchId: matchIdGame,
          });
        }
      }

      reply.send({ success: true, status: "starting", gameMatchId: matchIdGame });
    } catch (err) {
      reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

  // ----------------------------
  // Bracket view
  // ----------------------------
  fastify.get("/tournament/:id/bracket", async (req, reply) => {
    const { id } = req.params as any;
    try {
      await ensureMatchSchema((fastify as any).db);

      const onlineUsers = (fastify as any).onlineUsers as Map<number, string> | undefined;
      const tournament = await fastify.db.get(
        `SELECT t.*, 
         (SELECT COUNT(*) FROM Player WHERE tournament_id = t.tournament_id) as player_count
         FROM Tournament t WHERE t.tournament_id = ?`,
        [id]
      );
      if (!tournament) return reply.status(404).send({ success: false, message: "Tournament not found" });

      const playersRaw = await fetchTournamentPlayers((fastify as any).db, Number(id));
      const players = playersRaw.map((p: any) => ({
        ...p,
        online: onlineUsers ? onlineUsers.has(p.user_id) : false,
      }));

      const matches = await fastify.db.all(
        `SELECT 
            m.match_id, m.round, m.slot, m.winner, m.tournament_id,
            p1.player_id as p1_id, p1.user_id as p1_user_id, COALESCE(p1.nickname, u1.username) as p1_name, u1.avatar as p1_avatar,
            p2.player_id as p2_id, p2.user_id as p2_user_id, COALESCE(p2.nickname, u2.username) as p2_name, u2.avatar as p2_avatar
         FROM Match m
         LEFT JOIN Player p1 ON m.player1 = p1.player_id
         LEFT JOIN User u1 ON p1.user_id = u1.id
         LEFT JOIN Player p2 ON m.player2 = p2.player_id
         LEFT JOIN User u2 ON p2.user_id = u2.id
         WHERE m.tournament_id = ?
         ORDER BY 
           CASE m.round WHEN 'quarter' THEN 1 WHEN 'semi' THEN 2 ELSE 3 END,
           m.slot`,
        [id]
      );

      const rounds = { quarter: [] as any[], semi: [] as any[], final: [] as any[] };
      matches.forEach((m: any) => {
        const obj = {
          match_id: m.match_id,
          round: m.round,
          slot: m.slot,
          winner: m.winner,
          player1: m.p1_id
            ? { id: m.p1_id, user_id: m.p1_user_id, name: m.p1_name, avatar: m.p1_avatar }
            : null,
          player2: m.p2_id
            ? { id: m.p2_id, user_id: m.p2_user_id, name: m.p2_name, avatar: m.p2_avatar }
            : null,
        };
        if (m.round === "quarter") rounds.quarter.push(obj);
        else if (m.round === "semi") rounds.semi.push(obj);
        else rounds.final.push(obj);
      });

      reply.send({ tournament, players, rounds });
    } catch (err) {
      reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

  // ----------------------------
  // Report match result & auto-progress
  // ----------------------------
  fastify.post("/tournament/:id/match/:matchId/result", async (req, reply) => {
    const { id, matchId } = req.params as any;
    const { winner, scores } = req.body as any;

    const tournamentId = Number(id);
    const matchIdNum = Number(matchId);
    const winnerRaw = Number(winner);

    if (!winner && winner !== 0) {
      return reply.status(400).send({ success: false, message: "Winner player_id is required" });
    }

    try {
      const match = await fastify.db.get(
        `SELECT m.*,
                p1.player_id as p1_id, p1.user_id as p1_user_id,
                p2.player_id as p2_id, p2.user_id as p2_user_id
         FROM Match m
         LEFT JOIN Player p1 ON m.player1 = p1.player_id
         LEFT JOIN Player p2 ON m.player2 = p2.player_id
         WHERE m.match_id = ? AND m.tournament_id = ?`,
        [matchIdNum, tournamentId]
      );
      if (!match) return reply.status(404).send({ success: false, message: "Match not found" });

      // Normalize winner: accept player_id or user_id for either side
      let winnerPlayerId = match.player1; // default to player1 to avoid null
      if (winnerRaw === match.player1 || winnerRaw === match.player2) {
        winnerPlayerId = winnerRaw;
      } else if (winnerRaw === match.p1_user_id) {
        winnerPlayerId = match.player1;
      } else if (winnerRaw === match.p2_user_id) {
        winnerPlayerId = match.player2;
      } else {
        const maybePlayer = await fastify.db.get(
          `SELECT player_id FROM Player WHERE user_id = ? AND tournament_id = ?`,
          [winnerRaw, tournamentId]
        );
        if (maybePlayer?.player_id) winnerPlayerId = maybePlayer.player_id;
      }

      if (winnerPlayerId !== match.player1 && winnerPlayerId !== match.player2) {
        return reply.status(400).send({ success: false, message: "Winner must be one of the match players" });
      }

      const score1 = scores?.p1 ?? scores?.score1 ?? null;
      const score2 = scores?.p2 ?? scores?.score2 ?? null;
      await fastify.db.run(
        `UPDATE Match SET winner = ?, score1 = COALESCE(?, score1), score2 = COALESCE(?, score2) WHERE match_id = ?`,
        [winnerPlayerId, score1, score2, matchIdNum]
      );

      if (score1 !== null || score2 !== null) {
        await recordTournamentMatch((fastify as any).db, match.player1, match.player2, score1 ?? 0, score2 ?? 0);
      }

      const blockchainResult = await progressBracket(fastify, tournamentId);
      const liveMap: Map<number, { gameId: number; createdAt: number }> = (fastify as any).tournamentLiveMatches;
      liveMap?.delete(matchIdNum);

      const bracket = await fastify.inject({
        method: "GET",
        url: `/api/tournament/${tournamentId}/bracket`,
      });
      let payload: any = { success: true };
      if (bracket.statusCode === 200) {
        // fastify.inject returns a response with .payload as string
        const bracketJson = (bracket as any).json
          ? (bracket as any).json()
          : JSON.parse((bracket as any).payload || "{}");
        payload = { ...bracketJson, success: true };
      }
      if (blockchainResult) payload.blockchain = blockchainResult;
      if (blockchainResult) {
        await persistBlockchainResult((fastify as any).db, tournamentId, blockchainResult);
      }

      reply.send(payload);
    } catch (err) {
      reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

  // ----------------------------
  // Update tournament status (MODIFIÉ POUR BLOCKCHAIN)
  // ----------------------------
  fastify.patch("/tournament/:id/status", async (req, reply) => {
    const { id } = req.params as any;
    const { status } = req.body as any;

    if (!["pending", "ongoing", "finished"].includes(status)) {
      return reply.status(400).send({ success: false, message: "Invalid status value" });
    }

    try {
      // 1. Mise à jour locale (Base de données SQLite)
      await fastify.db.run(
        "UPDATE Tournament SET status = ? WHERE tournament_id = ?",
        [status, id]
      );

      // 2. LOGIQUE BLOCKCHAIN - Uniquement si le tournoi est fini
      if (status === "finished") {
        // On récupère les infos du tournoi pour l'envoyer à la blockchain
        const tournamentData = await fastify.db.get(
            `SELECT name, WinnerName, 
            (SELECT COUNT(*) FROM Player WHERE tournament_id = ?) as playerCount
            FROM Tournament WHERE tournament_id = ?`,
            [id, id]
        );

        if (tournamentData && tournamentData.WinnerName) {
          // 👇 On capture le résultat complet
          const blockchainResult = await blockchainService.recordTournament(
              tournamentData.name,
              tournamentData.WinnerName,
              tournamentData.playerCount || 8
        );
        await persistBlockchainResult((fastify as any).db, Number(id), blockchainResult);
        
        // 👇 On l'envoie au frontend dans la réponse
        return reply.send({ 
            success: true, 
            blockchain: blockchainResult 
        });
        } else {
            console.warn("⚠️ Impossible d'enregistrer sur la blockchain: Vainqueur introuvable.");
        }
      }

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
