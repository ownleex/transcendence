import {
    createTournament,
    fetchTournamentBracket,
    fetchTournaments,
    joinTournament,
    joinTournamentAlias,
    leaveTournament,
    readyTournamentMatch,
    reportTournamentResult,
} from "./api";
import { showGame } from "./pong";
import { io, Socket } from "socket.io-client";

type PlayerLight = {
    id: number;
    user_id?: number;
    displayName?: string;
    name?: string;
    avatar?: string | null;
};
type MatchLight = {
    match_id: number;
    round: "quarter" | "semi" | "final";
    slot: number;
    winner: number | null;
    player1: PlayerLight | null;
    player2: PlayerLight | null;
};

function renderMatchCard(match: MatchLight) {
    const p1Name = match.player1?.displayName || match.player1?.name || "TBD";
    const p2Name = match.player2?.displayName || match.player2?.name || "TBD";
    const p1Avatar = match.player1?.avatar || "/uploads/default.png";
    const p2Avatar = match.player2?.avatar || "/uploads/default.png";
    const p1Win = match.winner && match.player1 && match.winner === match.player1.id;
    const p2Win = match.winner && match.player2 && match.winner === match.player2.id;
    return `
      <div class="p-3 rounded-lg border ${match.winner ? "border-green-400 bg-green-50" : "border-gray-300 bg-white"} shadow-sm">
        <div class="flex items-center justify-between text-sm">
          <span class="flex items-center gap-2 ${p1Win ? "text-green-700 font-semibold" : "text-gray-700"}">
            <img src="${p1Avatar}" class="w-6 h-6 rounded-full object-cover border" />
            ${p1Name}
          </span>
          <span class="text-gray-400">vs</span>
          <span class="flex items-center gap-2 ${p2Win ? "text-green-700 font-semibold" : "text-gray-700"}">
            ${p2Name}
            <img src="${p2Avatar}" class="w-6 h-6 rounded-full object-cover border" />
          </span>
        </div>
        <p class="text-xs text-gray-400 mt-1">Match #${match.match_id}</p>
      </div>
    `;
}

function findNextMatch(rounds: { quarter: MatchLight[]; semi: MatchLight[]; final: MatchLight[] }) {
    const order: Array<keyof typeof rounds> = ["quarter", "semi", "final"];
    for (const round of order) {
        const match = (rounds[round] || []).find((m) => m.player1 && m.player2 && !m.winner);
        if (match) return { match, round };
    }
    return null;
}

type BlockchainResult = {
    blockNumber?: number;
    explorerUrl?: string;
    contractUrl?: string;
    txHash?: string;
};

function extractBlockchainResult(tournament: any): BlockchainResult | null {
    if (!tournament) return null;
    const blockNumber = tournament.BlockchainBlockNumber ?? tournament.blockchainBlockNumber;
    const explorerUrl = tournament.BlockchainExplorerUrl ?? tournament.blockchainExplorerUrl;
    const contractUrl = tournament.BlockchainContractUrl ?? tournament.blockchainContractUrl;
    const txHash = tournament.BlockchainTxHash ?? tournament.blockchainTxHash;
    if (blockNumber || explorerUrl || contractUrl || txHash) {
        return { blockNumber, explorerUrl, contractUrl, txHash };
    }
    return null;
}

function getCachedBlockchainResult(tournamentId: number): BlockchainResult | null {
    const cacheKey = `tournament-blockchain-${tournamentId}`;
    try {
        const raw = sessionStorage.getItem(cacheKey);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function renderBlockchainCard(container: HTMLElement, bc: BlockchainResult) {
    container.innerHTML = `
        <div class="p-6 bg-green-50 border border-green-200 rounded-lg shadow-md mt-8 max-w-2xl mx-auto">
            <h2 class="text-2xl font-bold text-green-800 mb-4">🏆 Certified tournament</h2>
            
            <div class="space-y-3 text-left">
                <div class="flex items-center">
                    <span class="font-semibold w-24">Block :</span>
                    <span class="font-mono bg-white px-2 py-1 rounded border">${bc.blockNumber ?? "?"}</span>
                </div>
                <div class="flex items-center">
                    <span class="font-semibold w-24">Proof :</span>
                    <a href="${bc.explorerUrl || "#"}" target="_blank" class="text-blue-600 hover:text-blue-800 underline flex items-center gap-1">
                        View transaction
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                    </a>
                </div>

                <div class="flex items-center">
                    <span class="font-semibold w-24">Contract :</span>
                    <a href="${bc.contractUrl || "#"}" target="_blank" class="text-blue-600 hover:text-blue-800 underline flex items-center gap-1">
                        See the smart contract
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                    </a>
                </div>
            </div>
            
            <p class="text-xs text-green-600 mt-4 text-center">Data recorded on Avalanche Fuji.</p>
        </div>
    `;
}

export async function finishTournament(tournamentId: number, container: HTMLElement, blockchainData?: BlockchainResult) {
    const cacheKey = `tournament-blockchain-${tournamentId}`;
    const cached = blockchainData
        || (() => {
            try {
                const raw = sessionStorage.getItem(cacheKey);
                return raw ? JSON.parse(raw) : null;
            } catch {
                return null;
            }
        })();

    if (cached) {
        renderBlockchainCard(container, cached);
        return;
    }

    container.innerHTML = `
        <div class="text-center mt-10">
            <p class="text-xl animate-pulse">⏳ Enregistrement sur la Blockchain en cours...</p>
            <p class="text-sm text-gray-500">Cela peut prendre 10 a 15 secondes.</p>
        </div>
    `;

    try {
        const response = await fetch(`/api/tournament/${tournamentId}/status`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "finished" })
        });

        const data = await response.json();

        if (data.success && data.blockchain) {
            renderBlockchainCard(container, data.blockchain);
            try {
                sessionStorage.setItem(cacheKey, JSON.stringify(data.blockchain));
            } catch {
                // Ignore storage failures
            }
        } else {
            container.innerHTML = `<div class="text-red-500">❌ Erreur: ${data.error || data.message || "Probleme inconnu"}</div>`;
        }
    } catch (e) {
        console.error(e);
        container.innerHTML = `<div class="text-red-500">❌ Erreur de connexion au serveur.</div>`;
    }
}

export async function showTournament(container: HTMLElement) {
    const me = JSON.parse(sessionStorage.getItem("me") || localStorage.getItem("me") || "{}");
    const myId = me?.id ? Number(me.id) : null;
    const storedId = sessionStorage.getItem("activeTournamentId") || localStorage.getItem("activeTournamentId");
    let activeId: number | undefined = storedId ? Number(storedId) : undefined;
    const socket: Socket | null = (window as any).appSocket || null;
    let socketListenersAttached = false;

    async function loadAndRender() {
        container.innerHTML = `<div class="text-gray-500">Loading tournaments...</div>`;

        try {
            const tournamentsRes = await fetchTournaments();
            const tournaments = tournamentsRes.tournaments || [];
            const hasActive = activeId && tournaments.some((t: any) => t.tournament_id === activeId);

            if (!hasActive) {
                // Clear stale storage if it pointed to a deleted tournament
                sessionStorage.removeItem("activeTournamentId");
                localStorage.removeItem("activeTournamentId");
                activeId = tournaments[0]?.tournament_id;
            }

            if (!activeId) {
                container.innerHTML = `
                    <div class="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
                        <p class="text-gray-700 dark:text-gray-200 mb-4">No tournament available. Create one to start a bracket of 8 players.</p>
                        <button id="createFromBracket" class="px-4 py-2 bg-blue-600 text-white rounded">Create tournament</button>
                    </div>
                `;
                document.getElementById("createFromBracket")?.addEventListener("click", async () => {
                    if (!me?.id) return;
                    const name = `Open ${new Date().toLocaleString()}`;
                    const res = await createTournament({ name, admin_id: me.id, max_players: 8 });
                    activeId = res.tournament_id;
                    sessionStorage.setItem("activeTournamentId", String(activeId));
                    loadAndRender();
                });
                return;
            }

            sessionStorage.setItem("activeTournamentId", String(activeId));
            localStorage.setItem("activeTournamentId", String(activeId));

            const bracketData = await fetchTournamentBracket(activeId);
            const rounds = bracketData.rounds as { quarter: MatchLight[]; semi: MatchLight[]; final: MatchLight[] };
            const nextMatch = findNextMatch(rounds);

            const tournament = bracketData.tournament;
            const players = bracketData.players || [];
            const nextPlayers = nextMatch
                ? [Number(nextMatch.match.player1?.user_id), Number(nextMatch.match.player2?.user_id)].filter((n) =>
                      Number.isFinite(n)
                  )
                : [];
            const isOnlineMode = (tournament.mode || "online") === "online";
            const isInTournament = myId !== null && players.some((p: any) => Number(p.user_id) === myId);
            const canJoin = tournament.status !== "finished" && tournament.player_count < 8 && !isInTournament;
            const joinable = tournament.status !== "finished" && tournament.player_count < 8;

            const optionsHtml = tournaments
                .map(
                    (t: any) =>
                        `<option value="${t.tournament_id}" ${t.tournament_id === activeId ? "selected" : ""}>#${t.tournament_id} - ${t.name}</option>`
                )
                .join("");

            container.innerHTML = `
                <div class="flex flex-col gap-4">
                    <div class="flex flex-wrap items-center gap-3 justify-between">
                        <div>
                            <p class="text-xs text-gray-400">Tournament ID #${tournament.tournament_id}</p>
                            <h1 class="text-2xl font-bold text-gray-800 dark:text-gray-100">${tournament.name}</h1>
                            <p class="text-gray-500">Status: <strong>${tournament.status}</strong> • Mode: ${isOnlineMode ? "online" : "offline"} • Players ${tournament.player_count}/8</p>
                        </div>
                        <div class="flex gap-2 items-center flex-wrap">
                            <select id="tournamentSelector" class="border rounded px-2 py-1 text-sm">${optionsHtml}</select>
                            <button id="refreshBracket" class="px-3 py-1 bg-gray-200 dark:bg-gray-700 text-white rounded">Refresh</button>
                            ${joinable ? `<button id="joinTournament" class="px-3 py-1 bg-blue-600 text-white rounded">Join with alias or account</button>` : ""}
                            ${isInTournament ? `<button id="leaveTournament" class="px-3 py-1 bg-red-600 text-white rounded">Leave</button>` : ""}
                            <button id="newTournament" class="px-3 py-1 bg-indigo-600 text-white rounded">New tournament</button>
                            ${!isOnlineMode ? `
                                <input id="aliasInputBracket" type="text" placeholder="Alias to join" class="border px-2 py-1 rounded text-sm" />
                                <input id="aliasCountBracket" type="number" min="1" max="8" value="1" class="border px-2 py-1 rounded text-sm w-20" title="How many aliases to add"/>
                                <button id="addAliasBatch" class="px-3 py-1 bg-emerald-600 text-white rounded text-sm">Add aliases</button>
                            ` : ``}
                        </div>
                    </div>

                    <div class="grid md:grid-cols-3 gap-4">
                        <div class="bg-white dark:bg-gray-800 p-4 rounded shadow col-span-1">
                            <h3 class="font-semibold text-gray-700 dark:text-gray-200 mb-2">Players (${players.length}/8)</h3>
                        <ul class="space-y-1 text-gray-600 dark:text-gray-300 text-sm">
                            ${players
                                .map(
                                    (p: any, idx: number) =>
                                        `<li class="flex items-center gap-2">
                                            <span class="text-gray-400">${idx + 1}.</span>
                                            <img src="${p.avatar || "/uploads/default.png"}" class="w-6 h-6 rounded-full object-cover border" />
                                            <span class="flex items-center gap-1">
                                                ${p.displayName || p.username || p.name || `Player ${p.player_id}`}
                                                ${p.online ? `<span class="w-2 h-2 rounded-full bg-green-500 inline-block" title="Online"></span>` : `<span class="w-2 h-2 rounded-full bg-gray-400 inline-block" title="Offline"></span>`}
                                            </span>
                                        </li>`
                                )
                                .join("")}
                        </ul>
                            <p class="text-xs text-gray-400 mt-2">Bracket starts automatically when 8 players joined.</p>
                        </div>
                        <div class="md:col-span-2 grid grid-cols-1 md:grid-cols-3 gap-3">
                            <div>
                                <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Quarter-finals</h3>
                                <div class="space-y-2">
                                    ${rounds.quarter?.length
                                        ? rounds.quarter.map((m) => renderMatchCard(m)).join("")
                                        : `<p class="text-gray-500 text-sm">Waiting for 8 players...</p>`}
                                </div>
                            </div>
                            <div>
                                <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Semi-finals</h3>
                                <div class="space-y-2">
                                    ${rounds.semi?.length
                                        ? rounds.semi.map((m) => renderMatchCard(m)).join("")
                                        : `<p class="text-gray-500 text-sm">Waiting for quarter winners</p>`}
                                </div>
                            </div>
                            <div>
                                <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Final</h3>
                                <div class="space-y-2">
                                    ${rounds.final?.length
                                        ? rounds.final.map((m) => renderMatchCard(m)).join("")
                                        : `<p class="text-gray-500 text-sm">Waiting for semi winners</p>`}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="bg-white dark:bg-gray-800 p-4 rounded shadow">
                    ${
                        tournament.status === "finished" && bracketData.tournament.WinnerName
                            ? `<div class="flex items-center gap-2 text-green-600 font-semibold">
                                        <img src="${bracketData.tournament.WinnerAvatar || "/uploads/default.png"}" class="w-8 h-8 rounded-full object-cover border" />
                                        <span>Winner: ${bracketData.tournament.WinnerName}</span>
                                   </div>`
                            : nextMatch
                            ? `<div class="flex flex-col gap-3">
                                <div class="flex items-center justify-between">
                                    <div class="text-gray-700 dark:text-gray-200">
                                        <p class="font-semibold">Next match (${nextMatch.round})</p>
                                        <p class="text-sm">${nextMatch.match.player1?.name || "TBD"} vs ${nextMatch.match.player2?.name || "TBD"}</p>
                                        <p class="text-xs text-gray-500">Players must be online and ready to start online.</p>
                                    </div>
                                        <div class="flex gap-2">
                                        ${isOnlineMode ? `<div class="flex gap-2">
                                            <button id="readyOnline" class="px-4 py-2 bg-blue-600 text-white rounded">Ready & notify</button>
                                            <button id="resumeOnline" class="px-4 py-2 bg-amber-500 text-white rounded">Resume match</button>
                                        </div>` : ""}
                                        ${!isOnlineMode ? `<button id="startMatch" class="px-4 py-2 bg-green-600 text-white rounded">Play locally</button>` : ""}
                                    </div>
                                </div>
                                <div class="text-sm">
                                    <span class="inline-flex items-center gap-1 mr-3">
                                        <span class="${nextMatch.match.player1?.online ? "bg-green-500" : "bg-gray-400"} w-2 h-2 rounded-full"></span>
                                        ${nextMatch.match.player1?.name || "TBD"}
                                    </span>
                                    <span class="inline-flex items-center gap-1">
                                        <span class="${nextMatch.match.player2?.online ? "bg-green-500" : "bg-gray-400"} w-2 h-2 rounded-full"></span>
                                        ${nextMatch.match.player2?.name || "TBD"}
                                    </span>
                                </div>
                               </div>`
                            : tournament.player_count < 8
                            ? `<p class="text-gray-500 text-sm">Waiting for players to reach 8 to seed the bracket.</p>`
                            : `<p class="text-gray-500 text-sm">Bracket is complete.</p>`
                    }
                    <div id="blockchainCard" class="mt-4"></div>
                    </div>
                </div>
            `;

        const blockchainData = extractBlockchainResult(tournament) || getCachedBlockchainResult(tournament.tournament_id);
        const blockchainContainer = document.getElementById("blockchainCard");
        if (blockchainContainer) {
            if (blockchainData && tournament.status === "finished") {
                renderBlockchainCard(blockchainContainer, blockchainData);
                try {
                    sessionStorage.setItem(`tournament-blockchain-${tournament.tournament_id}`, JSON.stringify(blockchainData));
                } catch {
                    /* ignore storage errors */
                }
            } else if (tournament.status === "ongoing") {
                sessionStorage.removeItem(`tournament-blockchain-${tournament.tournament_id}`);

                blockchainContainer.innerHTML = `
                    <div class="p-4 bg-blue-50 border border-blue-200 rounded text-blue-800 flex items-center gap-2">
                        <span class="animate-pulse">⏳</span>
                        <span>The tournament is ongoing. Awaiting the final and registration on the Avalanche Fuji blockchain.</span>
                    </div>
                `;
            } else if (tournament.status === "finished") {
                if (isOnlineMode) {
                    blockchainContainer.innerHTML = `
                        <div class="p-4 bg-blue-50 border border-blue-200 rounded text-blue-800 flex flex-col gap-2">
                            <div class="flex items-center gap-2">
                                <span class="animate-pulse">🌐</span>
                                <span>Tournament finished. Recording on the blockchain...</span>
                            </div>
                            <div class="text-sm">
                                Please wait a few seconds, then click on the "Refresh" button
                            </div>
                        </div>
                    `;
                } else {
                    blockchainContainer.innerHTML = `
                        <div class="p-4 bg-amber-50 border border-amber-200 rounded text-amber-800 flex items-center gap-2">
                            <span class="animate-pulse">⌛</span>
                            <span>Tournament finished. Recording on the blockchain... The page will reload automatically.</span>
                        </div>
                    `;
                }
            } else {
                blockchainContainer.innerHTML = "";
            }
        }

        document.getElementById("refreshBracket")?.addEventListener("click", loadAndRender);
        document.getElementById("tournamentSelector")?.addEventListener("change", (e) => {
            const val = (e.target as HTMLSelectElement).value;
            if (val) {
                activeId = Number(val);
                sessionStorage.setItem("activeTournamentId", val);
                loadAndRender();
            }
        });

        document.getElementById("newTournament")?.addEventListener("click", async () => {
            if (!me?.id) {
                alert("You must be logged in to create a tournament.");
                return;
            }
            try {
                const name = `Open ${new Date().toLocaleString()}`;
                const res = await createTournament({ name, admin_id: me.id, max_players: 8 });
                activeId = res.tournament_id;
                sessionStorage.setItem("activeTournamentId", String(activeId));
                localStorage.setItem("activeTournamentId", String(activeId));
                const aliasInput = document.getElementById("aliasInputBracket") as HTMLInputElement | null;
                if (aliasInput) aliasInput.value = "";
                await loadAndRender();
            } catch (err: any) {
                alert(err?.message || "Failed to create tournament");
            }
        });

        if (joinable) {
            document.getElementById("joinTournament")?.addEventListener("click", async () => {
                const alias = (document.getElementById("aliasInputBracket") as HTMLInputElement)?.value.trim();
                try {
                    if (alias) {
                        await joinTournamentAlias({ tournament_id: tournament.tournament_id, alias });
                    } else if (myId) {
                        await joinTournament({
                            tournament_id: tournament.tournament_id,
                            user_id: myId,
                            nickname: me.username,
                        });
                    } else {
                        alert("Please enter an alias to join.");
                        return;
                    }
                    await loadAndRender();
                } catch (err: any) {
                    alert(err.message || "Unable to join tournament");
                }
            });
        }

        if (!isOnlineMode) {
            document.getElementById("addAliasBatch")?.addEventListener("click", async () => {
                const aliasInput = document.getElementById("aliasInputBracket") as HTMLInputElement | null;
                const countInput = document.getElementById("aliasCountBracket") as HTMLInputElement | null;
                const baseAlias = aliasInput?.value.trim();
                const count = Math.min(8, Math.max(1, Number(countInput?.value || 1)));
            if (!baseAlias) {
                alert("Please enter an alias base.");
                return;
            }
                try {
                    for (let i = 0; i < count; i++) {
                        const alias = i === 0 ? baseAlias : `${baseAlias}_${i + 1}`;
                        await joinTournamentAlias({ tournament_id: tournament.tournament_id, alias });
                    }
                    await loadAndRender();
                } catch (err: any) {
                    alert(err.message || "Failed to add aliases");
                }
            });
        }

        if (isInTournament) {
            document.getElementById("leaveTournament")?.addEventListener("click", async () => {
                if (!myId) return;
                try {
                    await leaveTournament(tournament.tournament_id, myId);
                    await loadAndRender();
                } catch (err: any) {
                    alert(err.message || "Unable to leave tournament");
                }
            });
        }

        if (nextMatch) {
            const match = nextMatch.match;
            const isFinalMatch = match.round === "final";
            const labels = {
                p1: match.player1?.name || match.player1?.displayName || "P1",
                p2: match.player2?.name || match.player2?.displayName || "P2",
            };

            if (isOnlineMode && isInTournament) {
                let pollTimer: number | null = null;

                const startPollingForMatch = () => {
                    let attempts = 0;
                    const maxAttempts = 5;
                    const poll = async () => {
                        attempts += 1;
                        try {
                            const res = await readyTournamentMatch(tournament.tournament_id, match.match_id, myId!);
                            if (res?.gameMatchId) {
                                if (pollTimer) {
                                    window.clearInterval(pollTimer);
                                    pollTimer = null;
                                }
                                await launchMatch(res.gameMatchId);
                            }
                        } catch (err) {
                            console.warn("Polling ready failed", err);
                        }
                        if (attempts >= maxAttempts && pollTimer) {
                            window.clearInterval(pollTimer);
                            pollTimer = null;
                        }
                    };
                    pollTimer = window.setInterval(poll, 1200);
                };

                const launchMatch = async (gameMatchId: number) => {
                    const p1Id = match.player1?.id || match.player1?.user_id;
                    const p2Id = match.player2?.id || match.player2?.user_id;
                    await showGame(container, "duo", {
                        playerLabels: labels,
                        matchId: gameMatchId,
                        source: "tournament",
                        onEnd: async (result) => {
                            const winnerKey = result.winner;
                            const scores = result.scores || {};
                            let winnerId =
                                winnerKey === "p1"
                                    ? p1Id
                                    : winnerKey === "p2"
                                    ? p2Id
                                    : undefined;
                            if (!winnerId) {
                                const s1 = scores.p1 ?? 0;
                                const s2 = scores.p2 ?? 0;
                                winnerId = s1 >= s2 ? p1Id : p2Id;
                            }
                            if (winnerId) {
                                try {
                                    const resultPayload = await reportTournamentResult(
                                        tournament.tournament_id,
                                        match.match_id,
                                        Number(winnerId),
                                        scores
                                    );
                                    if (isFinalMatch) {
                                        await loadAndRender();
                                        const bcContainer = document.getElementById("blockchainCard");
                                        if (bcContainer) {
                                            await finishTournament(tournament.tournament_id, bcContainer, resultPayload?.blockchain);
                                            await loadAndRender();
                                        }
                                        return;
                                    }
                                    await loadAndRender();
                                } catch (err) {
                                    console.error(err);
                                    alert("Failed to record match result");
                                    await loadAndRender();
                                }
                            }
                        },
                    });
                };

                document.getElementById("readyOnline")?.addEventListener("click", async () => {
                    if (!myId) {
                        alert("You must be logged in to be marked ready online.");
                        return;
                    }
                    if (!nextPlayers.includes(myId)) {
                        alert("Only players in the next match can ready up.");
                        return;
                    }
                    try {
                        // One-time listener for match start (in case this client doesn't get gameMatchId directly)
                        const startHandler = async (payload: any) => {
                            if (!payload?.gameMatchId || payload?.bracketMatchId !== match.match_id) return;
                            socket?.off("tournament:match:start", startHandler);
                            await launchMatch(payload.gameMatchId);
                        };
                        socket?.on("tournament:match:start", startHandler);

                        const res = await readyTournamentMatch(tournament.tournament_id, match.match_id, myId);
                        if (socket) {
                            socket.emit("joinMatchChat", match.match_id);
                        }
                        // If backend already started a game match, auto-join it
                        if (res?.gameMatchId) {
                            socket?.off("tournament:match:start", startHandler);
                            await launchMatch(res.gameMatchId);
                        } else {
                            alert("Marked ready. Waiting for the other player.");
                            startPollingForMatch();
                        }
                    } catch (err: any) {
                        alert(err?.message || "Failed to mark ready. Ensure you are online.");
                    }
                });

                document.getElementById("resumeOnline")?.addEventListener("click", async () => {
                    if (!myId) {
                        alert("You must be logged in to resume.");
                        return;
                    }
                    try {
                        const res = await readyTournamentMatch(tournament.tournament_id, match.match_id, myId);
                        if (res?.gameMatchId) {
                            await launchMatch(res.gameMatchId);
                        } else {
                            alert("No live match to resume yet. Click Ready instead.");
                        }
                    } catch (err: any) {
                        alert(err?.message || "Failed to resume the match");
                    }
                });
            }

            document.getElementById("startMatch")?.addEventListener("click", async () => {
                const p1Id = match.player1?.id || match.player1?.user_id;
                const p2Id = match.player2?.id || match.player2?.user_id;
                await showGame(container, "local-duo", {
                    playerLabels: labels,
                    onEnd: async (res) => {
                        const winnerKey = res.winner;
                        const scores = res.scores || {};
                        let winnerId =
                            winnerKey === "p1"
                                ? p1Id
                                : winnerKey === "p2"
                                ? p2Id
                                : undefined;

                        if (!winnerId) {
                            const p1Score = scores.p1 ?? 0;
                            const p2Score = scores.p2 ?? 0;
                            winnerId = p1Score >= p2Score ? p1Id : p2Id;
                        }

                        if (!winnerId) return;
                        try {
                            const resultPayload = await reportTournamentResult(
                                tournament.tournament_id,
                                match.match_id,
                                Number(winnerId),
                                scores
                            );
                            if (isFinalMatch) {
                                await loadAndRender();
                                const bcContainer = document.getElementById("blockchainCard");
                                if (bcContainer) {
                                    await finishTournament(tournament.tournament_id, bcContainer, resultPayload?.blockchain);
                                    await loadAndRender();
                                }
                                return;
                            }
                        } catch (err) {
                            console.error(err);
                            alert("Failed to record match result");
                        }
                        await loadAndRender();
                    },
                });
            });
        }
        } catch (err: any) {
            console.error(err);
            container.innerHTML = `<p class="text-red-500">Failed to load tournament: ${err?.message || err}</p>`;
        }
    }

    // Attach socket listeners once to refresh presence and auto-start  matches
    function ensureSocketListeners() {
        if (!socket || socketListenersAttached) return;
        socketListenersAttached = true;
        socket.on("user:online", () => {
            const currentHash = window.location.hash;
            if (currentHash === "#tournament") loadAndRender();
        });
        socket.on("user:offline", () => {
            const currentHash = window.location.hash;
            if (currentHash === "#tournament") loadAndRender();
        });
            socket.on("tournament:match:start", async (payload: any) => {
                if (!payload || !payload.tournamentId || !payload.gameMatchId) return;
                if (activeId && Number(payload.tournamentId) !== activeId) return;
                if (!myId) return;
                // Fetch bracket to confirm and get labels
                try {
                const bracketData = await fetchTournamentBracket(activeId || payload.tournamentId);
                const match = [...(bracketData.rounds.quarter || []), ...(bracketData.rounds.semi || []), ...(bracketData.rounds.final || [])]
                    .find((m: any) => m.match_id === payload.bracketMatchId);
                if (!match) return;
                const isFinalAuto = match.round === "final";
                const participantIds = [Number(match.player1?.user_id), Number(match.player2?.user_id)].filter((n) => Number.isFinite(n));
                if (!participantIds.includes(myId)) return;
                const labels = {
                    p1: match.player1?.name || match.player1?.displayName || "P1",
                    p2: match.player2?.name || match.player2?.displayName || "P2",
                };
                const p1Id = match.player1?.id || match.player1?.user_id;
                const p2Id = match.player2?.id || match.player2?.user_id;
                await showGame(container, "duo", {
                    playerLabels: labels,
                    matchId: payload.gameMatchId,
                    source: "tournament",
                    onEnd: async (result) => {
                        const winnerKey = result.winner;
                        const scores = result.scores || {};
                        let winnerId =
                            winnerKey === "p1"
                                ? p1Id
                                : winnerKey === "p2"
                                ? p2Id
                                : undefined;
                        if (!winnerId) {
                            const s1 = scores.p1 ?? 0;
                            const s2 = scores.p2 ?? 0;
                            winnerId = s1 >= s2 ? p1Id : p2Id;
                        }
                        if (winnerId) {
                            try {
                                const resultPayload = await reportTournamentResult(
                                    payload.tournamentId,
                                    match.match_id,
                                    Number(winnerId),
                                    scores
                                );
                                if (isFinalAuto) {
                                    await loadAndRender();
                                    const bcContainer = document.getElementById("blockchainCard");
                                    if (bcContainer) {
                                        await finishTournament(payload.tournamentId, bcContainer, resultPayload?.blockchain);
                                        await loadAndRender();
                                    }
                                    return;
                                }
                                await loadAndRender();
                            } catch (err) {
                                console.error(err);
                                alert("Failed to record match result");
                                await loadAndRender();
                            }
                        }
                    },
                });
                } catch (err) {
                    console.error("Failed to auto-start tournament match", err);
                }
            });
        }

    ensureSocketListeners();
    await loadAndRender();
}