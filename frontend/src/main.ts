
import { showHome } from "./home";
import { showGame } from "./pong";
import { showTournament } from "./tournament";
import {
    sendFriendRequest,
    acceptFriend,
    getFriends,
    getIncomingRequests,
    getSentRequests,
    blockFriend,
    unblockFriend,
    getMatchHistory,
    fetchUserMe,
    getUserProfile,
    setup2FA,
    verify2FA,
    disable2FA,
    createTournament,
    getLeaderboard,
} from "./api";
import { io } from "socket.io-client";
import { renderMatches } from "./matches";
import { renderTournaments } from "./tournamentinfor";
// -------------------------
// Global state
// -------------------------
let me = JSON.parse(sessionStorage.getItem("me") || localStorage.getItem("me") || "{}");
let token = sessionStorage.getItem("token") || localStorage.getItem("jwt");

console.log("[INIT] Loaded user from storage:", me);
console.log("[INIT] Loaded token:", token);

(window as any).currentUserId = me?.id ?? null;

// -------------------------
// Ensure current user (fresh /me every time)
// -------------------------
async function ensureCurrentUser() {
    try {
        const res = await fetchUserMe();
        if (res.success) {
            me = res.user;
            window.currentUserId = me.id;

            sessionStorage.setItem("me", JSON.stringify(me));
            localStorage.setItem("me", JSON.stringify(me)); 
	    console.log("[ensureCurrentUser] Updated me object:", me);
        } else {
            console.warn("[ensureCurrentUser] Failed to fetch /me:", res.error);
        }
    } catch (err) {
        console.error("[ensureCurrentUser] Error fetching user:", err);
    }
}
// -------------------------
// Profile rendering (current user)
// -------------------------
async function loadProfile(userId?: number) {
    const usernameEl = document.getElementById("profile-username");
    const emailEl = document.getElementById("profile-email");
    const eloEl = document.getElementById("profile-elo");
    const matchesEl = document.getElementById("profile-matches");
    const winrateEl = document.getElementById("profile-winrate");
    const avatarEl = document.getElementById("profile-avatar") as HTMLImageElement | null;

    let profile = me;
    if (Number.isFinite(userId) && userId !== me?.id) {
        try {
            const res = await getUserProfile(Number(userId));
            if ((res as any)?.user) {
                profile = (res as any).user;
            }
        } catch (err) {
            console.warn("Failed to load user profile, falling back to current user:", err);
        }
    }

    const safe = (v: any, fallback: string = "—") => (v === null || v === undefined || v === "" ? fallback : v);
    const displayName = safe(profile.nickname?.trim() || profile.username);
    usernameEl && (usernameEl.textContent = displayName);
    //usernameEl && (usernameEl.textContent = safe(profile.username));
    emailEl && (emailEl.textContent = safe(profile.email));
    eloEl && (eloEl.textContent = safe(profile.elo ?? profile.rank ?? "—"));
    matchesEl && (matchesEl.textContent = safe(profile.matches_played ?? profile.matches ?? "0"));
    if (winrateEl) {
        const wr =
            profile.winrate !== undefined && profile.winrate !== null
                ? `${Number(profile.winrate).toFixed(1)}%`
                : "—";
        winrateEl.textContent = wr;
    }
    if (avatarEl && profile.avatar) {
        avatarEl.src = profile.avatar;
    }
}
// ------------------------------
// DOMContentLoaded
// ------------------------------
window.addEventListener("DOMContentLoaded", async () => {
    const app = document.getElementById("pongContent")!;
     await ensureCurrentUser();

    console.log("[DOMContentLoaded] User ready:", me);

    // Initialize socket connection once at startup
    initSocket();

    // activate hash router
    window.addEventListener("hashchange", router);
    window.addEventListener("app:route-refresh", () => router());

    await router();

    // ---- Rebind des boutons de la Home après chaque render ----
    function bindHomeButtons() {
        const gameContainer = document.getElementById("gameContainer")!;
        const playDuoBtn = document.getElementById("playDuoBtn");
        const playDuoLocalBtn = document.getElementById("playDuoLocalBtn");
        const playQuadBtn = document.getElementById("playQuadBtn");
        const playQuadLocalBtn = document.getElementById("playQuadLocalBtn");
        const viewTournamentBtn = document.getElementById("viewtournamentBtn");   
        const quickAliasTournamentBtn = document.getElementById("quickAliasTournamentBtn");
        const quickRemoteTournamentBtn = document.getElementById("quickRemoteTournamentBtn");

        playDuoBtn?.addEventListener("click", () => {
            showGame(gameContainer, "duo", { source: "matchmaking" });
        });

        playDuoLocalBtn?.addEventListener("click", () => {
            showGame(gameContainer, "local-duo");
        });

        playQuadBtn?.addEventListener("click", () => {
            showGame(gameContainer, "quad", { source: "matchmaking" });
        });

        playQuadLocalBtn?.addEventListener("click", () => {
            showGame(gameContainer, "local-quad");
        });

        // bouton "View Tournaments" dans les quick actions
        viewTournamentBtn?.addEventListener("click", () => {
            window.location.hash = "#tournament";
        });  
        quickAliasTournamentBtn?.addEventListener("click", () => {
            (async () => {
                if (!me?.id) {
                    alert("You must be logged in to start an alias-only tournament.");
                    return;
                }
                const name = `Local tournament ${new Date().toLocaleString()}`;
                try {
                    const res = await createTournament({
                        name,
                        max_players: 8,
                        admin_id: me.id,
                        is_private: 0,
                        mode: "offline",
                    });
                    const tid = res.tournament_id || res.id;
                    if (tid) {
                        sessionStorage.setItem("activeTournamentId", String(tid));
                        localStorage.setItem("activeTournamentId", String(tid));
                    }
                    window.location.hash = "#tournament";
                } catch (err: any) {
                    alert(err?.message || "Failed to create alias-only tournament");
                }
            })();
        });
        quickRemoteTournamentBtn?.addEventListener("click", () => {
            (async () => {
                if (!me?.id) {
                    alert("You must be logged in to start a remote tournament.");
                    return;
                }
                const name = `Open ${new Date().toLocaleString()}`;
                try {
                    const res = await createTournament({
                        name,
                        max_players: 8,
                        admin_id: me.id,
                        is_private: 0,
                        mode: "online",
                    });
                    const tid = res.tournament_id || res.id;
                    if (tid) {
                        sessionStorage.setItem("activeTournamentId", String(tid));
                        localStorage.setItem("activeTournamentId", String(tid));
                    }
                    window.location.hash = "#tournament";
                } catch (err: any) {
                    alert(err?.message || "Failed to create remote tournament");
                }
            })();
        });      

        const resumeOnlineBtn = document.getElementById("resumeOnlineBtn") as HTMLButtonElement | null;
        const storedMatchId = localStorage.getItem("lastOnlineMatchId");
        const storedMode = localStorage.getItem("lastOnlineMatchMode");
        const storedSource = localStorage.getItem("lastOnlineMatchSource");
        if (resumeOnlineBtn) {
            if (storedMatchId && storedSource === "matchmaking") {
                resumeOnlineBtn.disabled = false;
            } else {
                resumeOnlineBtn.disabled = true;
            }
            resumeOnlineBtn.addEventListener("click", () => {
                if (!storedMatchId || storedSource !== "matchmaking") return;
                const matchId = Number(storedMatchId);
                if (!Number.isFinite(matchId)) return;
                const mode = storedMode === "quad" ? "quad" : "duo";
                // Validate status before trying to join
                fetch(`/api/match/status?matchId=${matchId}`)
                    .then((r) => r.json())
                    .then((data) => {
                        if (!data?.active) {
                            localStorage.removeItem("lastOnlineMatchId");
                            localStorage.removeItem("lastOnlineMatchMode");
                            localStorage.removeItem("lastOnlineMatchSource");
                            resumeOnlineBtn.disabled = true;
                            alert("No active match to resume.");
                            return;
                        }
                        if (!data.players || !data.players.includes(Number(me?.id))) {
                            alert("You are not part of this match anymore.");
                            return;
                        }
                        showGame(gameContainer, mode, { matchId, source: "matchmaking" });
                    })
                    .catch(() => {
                        alert("Unable to check match status. Try again.");
                    });
            });
        }
    }

    // -------------------------
    // Updated Router (supports friends + matches)
    // -------------------------
    async function router() {
        const hash = window.location.hash;
        app.innerHTML = "";

        // Always hide all panels first
        document.getElementById("friends-panel")?.classList.add("hidden");
        document.getElementById("matches-panel")?.classList.add("hidden");
        document.getElementById("profile-panel")?.classList.add("hidden");
        document.getElementById("leaderboard-panel")?.classList.add("hidden");
        switch (hash) {
            case "":
            case "#home":
                showHome(app);
                bindHomeButtons();
                break;
            case "#matchesinfor":
                await ensureCurrentUser();
                renderMatches(app);
                break;

            case "#tournamentinfor":
                await ensureCurrentUser();
                renderTournaments(app);
                break;

            case "#tournament":
                await showTournament(app);
                break;

            case "#friends":
                document.getElementById("friends-panel")!.classList.remove("hidden");
                await ensureCurrentUser();
                await loadAllFriendsData();
                break;

            case "#matches":
                document.getElementById("matches-panel")!.classList.remove("hidden");
                await ensureCurrentUser();
                await window.showMatchesPanel(window.currentUserId);
                break;

            case "#leaderboard":
                document.getElementById("leaderboard-panel")!.classList.remove("hidden");
                await ensureCurrentUser();
                await loadLeaderboard();
                break;

            case "#profile":
                document.getElementById("profile-panel")!.classList.remove("hidden");
                await ensureCurrentUser();
                const profileTargetRaw = sessionStorage.getItem("profileUserId");
                const profileTarget = profileTargetRaw ? Number(profileTargetRaw) : undefined;
                await loadProfile(Number.isFinite(profileTarget) ? Number(profileTarget) : undefined);
                sessionStorage.removeItem("profileUserId");
                break;

            case "#auth":
                document.getElementById("authentication-panel")!.classList.remove("hidden");
                await ensureCurrentUser();
                init2FASetup();
                init2FADisable();                
                update2FAButtons();
                break;          

            default:
                app.innerHTML = `<p class="text-red-500">Page not found</p>`;
        }
    }

    // -------------------------
    // Navbar buttons
    // -------------------------
    document.getElementById("homeBtn")?.addEventListener("click", () => {
    // si un jeu tourne, on le stoppe proprement
    if ((window as any).stopCurrentGame) {
        try { (window as any).stopCurrentGame(); } catch (e) { console.warn(e); }
    }
    window.location.hash = "#home";
  });
    document.getElementById("tournamentBtn")?.addEventListener("click", () => (window.location.hash = "#tournament"));
    document.getElementById("matchesBtn")?.addEventListener("click", (e) => {
        e.preventDefault?.();
        window.location.hash = "#matchesinfor";
    });
    document.getElementById("leaderboardBtn")?.addEventListener("click", () => (window.location.hash = "#leaderboard"));

    // Dropdown buttons
    document.querySelector('#userMenuDropdown [data-target="profile-panel"]')
        ?.addEventListener("click", () => (window.location.hash = "#profile"));

    document.querySelector('#userMenuDropdown [data-target="matches-panel"]')
        ?.addEventListener("click", () => (window.location.hash = "#matches"));

    document.querySelector('#userMenuDropdown [data-target="friends-panel"]')
        ?.addEventListener("click", () => (window.location.hash = "#friends"));

    document.querySelector('#userMenuDropdown [data-target="authentication-panel"]')
        ?.addEventListener("click", () => (window.location.hash = "#auth"));
});

// Store user in sessionStorage on login
window.saveUserSession = function (user: any) {
    console.log("[saveUserSession] Saving user:", user);
    sessionStorage.setItem("me", JSON.stringify(user));
    sessionStorage.setItem("token", user.token);

    // Optional: also persist in localStorage for regular sessions
    localStorage.setItem("me", JSON.stringify(user));
    localStorage.setItem("jwt", user.token);

    me = user;
    token = user.token;
    window.currentUserId = user.id;
};

// Show friends panel
window.showFriendsPanel = function () {
    document.getElementById("friends-panel")!.classList.remove("hidden");
    loadAllFriendsData();
};

// ----------------------------
// Friends (accepted)
// ----------------------------
let socket: ReturnType<typeof io> | null = null;

function initSocket() {
    if (socket) return; // Socket already initialized

    const token = localStorage.getItem("jwt");
    if (!token) return;

    const socketUrl = (window as any).SOCKET_URL || window.location.origin;
    socket = io(socketUrl, { auth: { token }, withCredentials: true });
    (window as any).appSocket = socket;
    socket.on("connect", () => {
        console.log("[socket] Connected as", token);
    });

    // Friend online/offline updates
    socket.on("user:online", ({ userId }: { userId: number }) => updateFriendStatus(userId, true));
    socket.on("user:offline", ({ userId }: { userId: number }) => updateFriendStatus(userId, false));

    socket.on("connect", () => {
        console.log("[socket] Connected - requesting online friends");
        requestOnlineFriendsUpdate();
    });

    socket.on("onlineFriends", (onlineIds: number[]) => {
        onlineIds.forEach(id => updateFriendStatus(id, true));
    });
     // -------------------------
    // 🔥 NEW: Real-time friend requests
    // -------------------------
    socket.on("friend:request", () => {
        console.log("[socket] Received a new friend request");
        loadIncomingRequests();
    });
    /*
    socket.on("friend:accepted", () => {
        console.log("[socket] Your friend request was accepted");
        loadAllFriendsData();
    });
    */
    socket.on("friend:accepted", async ({ userId }: { userId: number }) => {
        console.log("[socket] Friend accepted:", userId);

        // Reload all friend data
        await loadAllFriendsData();

        // After loading friends, request online status update
        requestOnlineFriendsUpdate();
    });
}

// Helper to request online status for all friends
function requestOnlineFriendsUpdate() {
    if (!socket) return;

    const friendIds = Array.from(document.querySelectorAll("#friends-list [data-user-id]"))
        .map(el => Number(el.getAttribute("data-user-id")));

    if (friendIds.length > 0) {
        console.log("[socket] Requesting online status for friends:", friendIds);
        socket.emit("get:onlineFriends", friendIds);
    }
}

// ----------------------------
// Load friend list
// ----------------------------
async function loadFriendList() {
    const container = document.getElementById("friends-list")!;
    container.innerHTML = "Loading...";

    const res = await getFriends(window.currentUserId);    
    if (!res.success) {
        container.innerHTML = "Failed to load friends";
        return;
    }

    container.innerHTML = "";

    res.friends.forEach(friend => {
        if (!window.currentUserId || friend.id === window.currentUserId) return;
        const item = document.createElement("div");
        item.id = `friend-${friend.id}`;
        item.setAttribute("data-user-id", friend.id.toString());
        item.className = "p-2 border rounded mb-1 flex justify-between items-center gap-3";

        item.innerHTML = `
            <div class="flex items-center gap-2">
                <span class="text-gray-500">${friend.username}</span>
                <span class="status text-gray-500">○ offline</span>
            </div>
            <button class="block-btn px-2 py-1 bg-red-600 text-white text-xs rounded" data-id="${friend.id}">
                Block
            </button>
        `;

        container.appendChild(item);
    });

    // Init socket (only once, on first call)
    initSocket();

    // Request online status for all friends
    requestOnlineFriendsUpdate();
}

// ----------------------------
// Update friend status dynamically
// ----------------------------
function updateFriendStatus(userId: number, online: boolean) {
    const el = document.querySelector(`[data-user-id="${userId}"] .status`);
    if (el) {
        el.textContent = online ? "● online" : "○ offline";
        el.className = online ? "status text-green-500" : "status text-gray-500";
    }
}

// ----------------------------
// Incoming friend requests
// ----------------------------
    async function loadIncomingRequests() {
        const container = document.getElementById("friends-incoming")!;
        container.innerHTML = "Loading...";

        const res = await getIncomingRequests(window.currentUserId);        
        if (!res.success) {
            container.innerHTML = "Failed to load requests";
            return;
        }

        container.innerHTML = "";

        res.requests.forEach(req => {
            const div = document.createElement("div");
            div.className = "p-2 border rounded mb-1 flex justify-between items-center";
            let blockButtonHTML = "";

            if (req.status === "blocked") {
                blockButtonHTML = `
                    <button class="unblock-btn px-2 py-1 bg-blue-600 text-white text-xs rounded"
                            data-id="${req.id}">
                        Unblock
                    </button>
                `;
                        } else {
                            blockButtonHTML = `
                    <button class="block-btn px-2 py-1 bg-red-600 text-white text-xs rounded"
                            data-id="${req.id}">
                        Block
                    </button>
                `;
            }

            div.innerHTML = `
                <span>${req.username}</span>
                <div class="flex gap-2">
                    <button class="accept-btn px-2 py-1 bg-green-600 text-white text-xs rounded"
                            data-id="${req.id}">
                        Accept
                    </button>
                    ${blockButtonHTML}
                </div>
            `;
            
            container.appendChild(div);
        });

      // Attach event listeners
    container.querySelectorAll(".accept-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
            const friendId = btn.getAttribute("data-id");
            if (!friendId) return;

            const result = await acceptFriend(Number(friendId));
            if (result.success) loadAllFriendsData();
        });
    });
}
  // ----------------------------
    // Event listener for accept/block
// ----------------------------
document.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;

    // -------------------------------
    // ACCEPT
    // -------------------------------
    if (target.classList.contains("accept-btn")) {
        const requesterId = Number(target.dataset.id);
        await acceptFriend(requesterId);
        await blockFriend(userId);
        loadIncomingRequests();
        loadSentRequests();
        loadFriendList();
    }

    // -------------------------------
    // BLOCK → UNBLOCK
    // -------------------------------
    if (target.classList.contains("block-btn")) {
        const userId = Number(target.dataset.id);

        // swap instantly in UI
        target.outerHTML = `
            <button class="unblock-btn px-2 py-1 bg-blue-600 text-white text-xs rounded"
                    data-id="${userId}">
                Unblock
            </button>
        `;

        // backend update + reload
        await blockFriend(userId);
        loadIncomingRequests();
        loadSentRequests();
    }

    // -------------------------------
    // UNBLOCK → BLOCK
    // -------------------------------
    if (target.classList.contains("unblock-btn")) {
        const userId = Number(target.dataset.id);

        // instant UI change
        target.outerHTML = `
            <button class="block-btn px-2 py-1 bg-red-600 text-white text-xs rounded"
                    data-id="${userId}">
                Block
            </button>
        `;

        // backend update + reload
        await unblockFriend(userId);
        await unblockFriend(userId);
        loadIncomingRequests();
        loadSentRequests();
        loadFriendList();
    }
});

// ----------------------------
// Sent friend requests
// ----------------------------
async function loadSentRequests() {
    const container = document.getElementById("friends-sent")!;
    container.innerHTML = "Loading...";

    const res = await getSentRequests(window.currentUserId);   
    if (!res.success) {
        container.innerHTML = "Failed to load sent requests";
        return;
    }

    container.innerHTML = "";
    res.sent.forEach(req => {
        const div = document.createElement("div");
        div.className = "request-item p-2 border rounded mb-1 flex justify-between items-center";

          // Status text depending on friend.status
        let statusText = "";
        if (req.status === "pending") {
            statusText = `<span class="text-yellow-500 text-xs">Pending</span>`;
        } else if (req.status === "blocked") {
            statusText = `<span class="text-red-600 text-xs">Blocked</span>`;
        } else {
            statusText = `<span class="text-gray-400 text-xs">${req.status}</span>`;
        }

        div.innerHTML = `
            <span>${req.username}</span>
            ${statusText}
        `;

        container.appendChild(div);
    });
}

// ----------------------------
// Load all friend data
// ----------------------------
async function loadAllFriendsData() {
    await loadFriendList();
    await loadIncomingRequests();
    await loadSentRequests();
}
// ----------------------------
// Send friend request form
// ----------------------------
const friendForm = document.getElementById("friend-send-form") as HTMLFormElement;
friendForm.addEventListener("submit", async e => {
    e.preventDefault();

    const input = document.getElementById("friend-username-input") as HTMLInputElement;
    const username = input.value.trim();
    const messageEl = document.getElementById("friend-send-message")!;
    if (!username) return;

    try {
        await sendFriendRequest(username);
        messageEl.textContent = `Friend request sent to ${username}`;
        input.value = "";
        loadAllFriendsData();
    } catch (err: any) {
        messageEl.textContent = err.message;
    }
});

// ----------------------------
// Show Matches Panel
// ----------------------------

window.showMatchesPanel = function (userId?: number) {
    const id = userId ?? window.currentUserId;
    console.log("[showMatchesPanel] Called with:", userId);
    console.log("[showMatchesPanel] currentUserId:", window.currentUserId);
    if (!id) {
        console.error("No valid user ID to show match history");
        const container = document.getElementById("matches-list")!;
        container.innerHTML = "<p class='text-red-400'>Cannot load match history: user not logged in.</p>";
        return;
    }

    document.getElementById("matches-panel")!.classList.remove("hidden");
    loadMatchHistory(id);
};

// ----------------------------
// Leaderboard
// ----------------------------
async function loadLeaderboard() {
    const container = document.getElementById("leaderboard-list")!;
    container.innerHTML = "Loading leaderboard...";
    try {
        const res = await getLeaderboard();
        const rows = res?.leaderboard || res || [];
        if (!rows.length) {
            container.innerHTML = "<p class='text-gray-400'>No players yet.</p>";
            return;
        }
        const normalizeAvatar = (url?: string) => {
            if (!url) return "/uploads/default.png";
            if (url.startsWith("http")) return url;
            return url.startsWith("/uploads/") ? url : `/uploads/${url}`;
        };
        container.innerHTML = rows
            .map((p: any, idx: number) => {
                const rank = p.rank ?? idx + 1;
                return `
          <div class="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm">
            <div class="flex items-center gap-3">
              <div class="w-8 text-center font-bold text-purple-600">${rank}</div>
              <img src="${normalizeAvatar(p.avatar)}" class="h-12 w-12 rounded-full border object-cover" alt="${p.username}">
              <div>
                <div class="text-sm font-semibold text-gray-800 dark:text-gray-100">${p.username}</div>
                <div class="text-xs text-gray-500">${p.matches_played ?? 0} matches · ${Number(p.winrate ?? 0).toFixed(1)}% WR</div>
              </div>
            </div>
            <div class="text-lg font-bold text-gray-800 dark:text-gray-100">ELO ${p.elo ?? "—"}</div>
          </div>
        `;
            })
            .join("");
    } catch (err) {
        console.error("[loadLeaderboard] failed", err);
        container.innerHTML = "<p class='text-red-400'>Failed to load leaderboard.</p>";
    }
}

// ----------------------------
// Load Match History
// ----------------------------
async function loadMatchHistory(userId: number) {
    console.log("[loadMatchHistory] Called with userId =", userId);
    const container = document.getElementById("matches-list")!;
    container.innerHTML = "Loading match history...";

    function formatMatchDate(dateStr: string) {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return dateStr;
        return date.toLocaleString();
    }

    try {
        const token = localStorage.getItem('jwt') || sessionStorage.getItem('token');
        console.log("[loadMatchHistory] Token found:", token);
        if (!token) {
            container.innerHTML = "<p class='text-red-400'>No JWT token found. Please log in again.</p>";
            return;
        }
        console.log("[loadMatchHistory] Fetching match history for user:", userId);
        const response = await getMatchHistory(userId);
        console.log("Raw match history response:", response);

        const matches = response?.matches || [];

        if (!matches.length) {
            console.warn("[loadMatchHistory] No matches found for user:", userId);
            container.innerHTML = "<p class='text-gray-400'>No matches played yet.</p>";
            return;
        }

        const normalizeAvatar = (url?: string) => {
            if (!url) return "/uploads/default.png";
            if (url.startsWith("http")) return url;
            return url.startsWith("/uploads/") ? url : `/uploads/${url}`;
        };

        container.innerHTML = matches
            .map((m: any) => {
                const isUserRow = m.user_id == userId;
                const left = {
                    name: m.user_name || `User ${m.user_id}`,
                    avatar: normalizeAvatar(m.user_avatar),
                    score: m.user_score ?? 0,
                };
                const right = {
                    name: m.opponent_name || `User ${m.opponent_id}`,
                    avatar: normalizeAvatar(m.opponent_avatar),
                    score: m.opponent_score ?? 0,
                };
                const winner =
                    left.score === right.score ? "draw" : left.score > right.score ? "left" : "right";
                const yourElo = m.user_id == userId ? m.user_elo : "—";
                const badge =
                    winner === "draw"
                        ? `<span class="px-2 py-1 text-xs rounded bg-gray-500 text-white">Draw</span>`
                        : `<span class="px-2 py-1 text-xs rounded ${
                              winner === "left" ? "bg-green-600" : "bg-blue-600"
                          } text-white">Winner: ${winner === "left" ? left.name : right.name}</span>`;

                return `
            <div class="p-4 mb-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm">
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-3 ${winner === "left" ? "opacity-100" : "opacity-80"}">
                  <img src="${left.avatar}" class="h-12 w-12 rounded-full border border-gray-300 object-cover" alt="${left.name}">
                  <div>
                    <div class="text-sm font-semibold text-gray-800 dark:text-gray-100">${left.name}</div>
                    <div class="text-xs text-gray-500">${formatMatchDate(m.date)}</div>
                  </div>
                </div>
                <div class="text-xl font-bold text-gray-800 dark:text-gray-100">${left.score} — ${right.score}</div>
                <div class="flex items-center gap-3 ${winner === "right" ? "opacity-100" : "opacity-80"}">
                  <div class="text-right">
                    <div class="text-sm font-semibold text-gray-800 dark:text-gray-100">${right.name}</div>
                    <div class="text-xs text-gray-500">${formatMatchDate(m.date)}</div>
                  </div>
                  <img src="${right.avatar}" class="h-12 w-12 rounded-full border border-gray-300 object-cover" alt="${right.name}">
                </div>
              </div>
              <div class="mt-3 flex items-center justify-between">
                ${badge}
                <span class="text-xs text-gray-500">ELO (you): ${yourElo ?? "—"}</span>
              </div>
            </div>
          `;
            })
            .join("");

    } catch (err: any) {
        console.error("[loadMatchHistory] Failed to load match history:", err);
        container.innerHTML = "<p class='text-red-400'>Failed to load matches. Please try again later.</p>";
    }
}

// ----------------------------
// 2FA SETUP LOGIC
// ----------------------------
function init2FASetup() {
    const setupBtn = document.getElementById("setup2FA");
    const qrContainer = document.getElementById("qrcode-container");

    if (!setupBtn || !qrContainer) return;

    setupBtn.addEventListener("click", async () => {
        const token = sessionStorage.getItem("token") || localStorage.getItem("jwt");
        if (!token) { // JWT must exist
            qrContainer.innerHTML = "<p class='text-red-500'>User not authenticated.</p>";
            return;
        }

        qrContainer.innerHTML = "<p class='text-gray-500'>Generating QR code...</p>";

        try {
            const res = await setup2FA(); // API call already uses JWT

            if (!res.success) throw new Error(res.error || "Failed to generate 2FA");

            // Display QR + secret + input
            qrContainer.innerHTML = `
                <div class="mt-4 text-center">
                    <p class="text-sm text-gray-700 dark:text-gray-300 mb-2">
                        Scan this QR code with Google Authenticator or Authy:
                    </p>
                    <img src="${res.qrCodeDataURL}" class="mx-auto border rounded shadow" />
                    <p class="text-sm mt-3">Secret: <strong>${res.secret}</strong></p>
                    <div class="mt-4">
                        <input id="twofa-verify-input"
                               maxlength="6"
                               class="border p-2 rounded w-40 text-center"
                               placeholder="Enter 6-digit code">
                        <button id="twofa-verify-btn"
                                class="ml-2 px-3 py-1 bg-green-600 text-white rounded">
                            Verify
                        </button>
                        <p id="twofa-verify-msg" class="mt-2 text-sm"></p>
                    </div>
                </div>
            `;

            attach2FAVerifyHandler();

        } catch (err: any) {
            console.error("2FA setup error:", err);
            qrContainer.innerHTML = `<p class='text-red-500'>${err.message}</p>`;
        }
    });
}

// ----------------------------
// Verify 2FA
// ----------------------------
function attach2FAVerifyHandler() {
    const btn = document.getElementById("twofa-verify-btn");
    const input = document.getElementById("twofa-verify-input") as HTMLInputElement;
    const msg = document.getElementById("twofa-verify-msg");

    if (!btn || !input || !msg) return;

    btn.addEventListener("click", async () => {
        const totp = input.value.trim();

        if (totp.length !== 6) {
            msg.textContent = "Enter a 6-digit code";
            msg.className = "text-red-500 text-sm";
            return;
        }

        try {
            const res = await verify2FA(totp); // uses JWT automatically

            if (!res.success) {
                msg.textContent = res.error || "Invalid code";
                msg.className = "text-red-500 text-sm";
                return;
            }

            msg.textContent = "2FA successfully enabled!";
            msg.className = "text-green-500 text-sm";

        } catch (err: any) {
            msg.textContent = "Network error";
            msg.className = "text-red-500 text-sm";
        }
    });
}

// ----------------------------
// Disable 2FA
// ----------------------------
function init2FADisable() {
    const disableBtn = document.getElementById("disable2FA");
    const enableBtn = document.getElementById("setup2FA");

    if (!disableBtn) return;

    disableBtn.addEventListener("click", async () => {
        if (!confirm("Are you sure you want to disable Two-Factor Authentication?")) {
            return;
        }

        try {
            const res = await disable2FA(); // automatically uses JWT

            if (!res.success) throw new Error(res.error || "Failed to disable 2FA");

            alert("Two-factor authentication successfully disabled.");

            // Toggle UI
            enableBtn?.classList.remove("hidden");
            disableBtn.classList.add("hidden");

            // Update stored user data
            const me = JSON.parse(localStorage.getItem("me") || "{}");
            me.twofa_secret = null;
            localStorage.setItem("me", JSON.stringify(me));
            update2FAButtons();

            // Inform rest of app
            window.dispatchEvent(new CustomEvent("auth:changed"));
        } catch (err: any) {
            alert(err.message || "Network error disabling 2FA.");
            console.error(err);
        }
    });
}

function update2FAButtons() {
    const enableBtn = document.getElementById("setup2FA");
    const disableBtn = document.getElementById("disable2FA");

    if (!enableBtn || !disableBtn) return;

    if (me.twofa_secret) {
        enableBtn.classList.add("hidden");
        disableBtn.classList.remove("hidden");
    } else {
        enableBtn.classList.remove("hidden");
        disableBtn.classList.add("hidden");
    }
}
