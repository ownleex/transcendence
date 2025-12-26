import { io, Socket } from "socket.io-client";
import { blockFriend } from "./api";

export type GameMode = "duo" | "quad" | "local-duo" | "local-quad";
type GameOptions = {
    playerLabels?: Record<string, string>;
    onEnd?: (payload: { winner?: string; scores: Record<string, number> }) => void;
    matchId?: number;
    source?: "matchmaking" | "tournament";
};

type RemoteMode = "duo" | "quad";

type PaddleState = { p1: number; p2: number; p3?: number; p4?: number };

interface ClientState {
    paddles: PaddleState;
    ball: { x: number; y: number; vx: number; vy: number };
}

interface GameConfig {
    width: number;
    height: number;
    paddleLength: number;
    paddleThickness: number;
    ballRadius: number;
    paddleSpeed: number;
}

interface ServerStateMessage {
    type: "state";
    state: { paddles: PaddleState; ball: { x: number; y: number; vx: number; vy: number } };
    scores: Record<string, number>;
    config?: Partial<GameConfig>;
    names?: Record<string, string>;
}

interface ServerEndMessage {
    type: "end";
    winner?: string;
    reason?: string;
    leaver?: number;
}

const DEFAULT_CONFIG: GameConfig = {
    width: 600,
    height: 600,
    paddleLength: 100,
    paddleThickness: 10,
    ballRadius: 10,
    paddleSpeed: 5,
};

// --- Chat socket + global match state ---
let chatSocket: Socket | null = null;
let currentMatchId: number | null = null;

/**
 * Renders and starts a game (duo or quad) with match chat.
 */
export async function showGame(container: HTMLElement, mode: GameMode = "duo", options: GameOptions = {}) {
    const isLocal = mode.startsWith("local");
    const isQuad = mode === "quad" || mode === "local-quad";
    const remoteMode: RemoteMode = mode === "duo" || mode === "quad" ? mode : "duo";
    const source = options.source ?? "matchmaking";
    let nameLabels: Record<string, string> | undefined = options.playerLabels;
    const returnHash = window.location.hash || "#home";

    currentMatchId = null;
    container.innerHTML = isLocal
        ? ""
        : `<div class="flex items-center justify-center h-[60vh] text-xl font-semibold text-gray-700">Looking for a match...</div>`;

    const storedMe = sessionStorage.getItem("me") || localStorage.getItem("me") || "{}";
    const me = JSON.parse(storedMe);
    const currentUserId = Number(me.id) || null;

    // Local modes do not require a logged user
    if (!isLocal && !currentUserId) {
        alert("User not logged in!");
        return;
    }

    const token = localStorage.getItem("jwt") || sessionStorage.getItem("token");
    if (!isLocal && !token) {
        alert("No token found, please log in again.");
        return;
    }

    // Elements created after matchmaking (avoid premature render)
    let overlay: HTMLDivElement | null = null;
    let wrapper!: HTMLDivElement;
    let canvas!: HTMLCanvasElement;
    let ctx!: CanvasRenderingContext2D;
    let scoreBox!: HTMLDivElement;
    let statusBox!: HTMLDivElement;
    let readyButton: HTMLButtonElement | null = null;
    let messagesList: HTMLUListElement | null = null;
    let chatForm: HTMLFormElement | null = null;
    let chatInput: HTMLInputElement | null = null;

    // ---------------------------
    // State / config init
    // ---------------------------
    let config: GameConfig = { ...DEFAULT_CONFIG };
    let scores: Record<string, number> = isQuad ? { p1: 0, p2: 0, p3: 0, p4: 0 } : { p1: 0, p2: 0 };
    let state: ClientState = {
        paddles: isQuad
            ? { p1: config.height / 2, p2: config.height / 2, p3: config.width / 2, p4: config.width / 2 }
            : { p1: config.height / 2, p2: config.height / 2 },
        ball: {
            x: config.width / 2,
            y: config.height / 2,
            vx: 0,
            vy: 0,
        },
    };
    if (isLocal) {
        resetLocalBall(state, config);
    }

    const keys = new Set<string>();
    const keydownHandler = (e: KeyboardEvent) => {
        if (!isLocal && servePending && myPaddleIndex === serverIndex && !isPaused && (e.key === " " || e.key === "Enter")) {
            e.preventDefault();
            sendServe();
            return;
        }
        if (!isLocal && !matchStarted && !isReady && (e.key === " " || e.key === "Enter")) {
            e.preventDefault();
            sendReady();
            return;
        }
        keys.add(e.key);
    };
    const keyupHandler = (e: KeyboardEvent) => keys.delete(e.key);
    window.addEventListener("keydown", keydownHandler);
    window.addEventListener("keyup", keyupHandler);

    let gameSocket: Socket | null = null;
    let paddleInterval: number | null = null;
    let running = true;
    let matchStarted = isLocal;
    let isReady = isLocal;
    let myPaddleIndex: number | null = null;
    let isPaused = false;
    let matchEnded = false;
    let pendingReady = false;
    let servePending = false;
    let serverIndex: number | null = null;
    const setStatus = (text: string) => {
        if (statusBox) statusBox.textContent = text;
    };
    const updateServeUI = () => {
        if (!readyButton) return;
        if (!matchStarted || isPaused) {
            readyButton.style.display = "";
            if (!isReady) {
                readyButton.disabled = false;
                readyButton.textContent = "I'm ready";
            }
            return;
        }
        if (!servePending) {
            readyButton.style.display = "none";
            return;
        }
        readyButton.style.display = "block";
        if (myPaddleIndex && serverIndex === myPaddleIndex) {
            readyButton.disabled = false;
            readyButton.textContent = "Serve (Space/Enter)";
            setStatus("Your serve. Press Space or Enter.");
        } else {
            readyButton.disabled = true;
            readyButton.textContent = "Waiting for serve";
            setStatus("Waiting for opponent to serve...");
        }
    };
    const sendReady = () => {
        if (isLocal || isReady) return;
        if (!gameSocket || !gameSocket.connected) {
            pendingReady = true;
            if (readyButton) {
                readyButton.disabled = true;
                readyButton.textContent = "Ready (queued)";
            }
            setStatus("Connecting... ready queued");
            return;
        }
        isReady = true;
        if (readyButton) {
            readyButton.disabled = true;
            readyButton.textContent = "Ready";
        }
        setStatus("Ready - waiting for other players");
        if (gameSocket) {
            gameSocket.emit("ready");
        }
    };
    const sendServe = () => {
        if (isLocal || !gameSocket || !servePending || isPaused) return;
        if (myPaddleIndex && serverIndex === myPaddleIndex) {
            gameSocket.emit("serve");
        }
    };
    let returnTriggered = false;
    let historyPushed = false;
    const resumeMatchKey = "lastOnlineMatchId";
    const resumeMatchModeKey = "lastOnlineMatchMode";
    const resumeMatchSourceKey = "lastOnlineMatchSource";
    const storeResumeMatch = (id: number) => {
        if (isLocal || source !== "matchmaking") return;
        localStorage.setItem(resumeMatchKey, String(id));
        localStorage.setItem(resumeMatchModeKey, remoteMode);
        localStorage.setItem(resumeMatchSourceKey, source);
    };
    const clearResumeMatch = () => {
        if (source !== "matchmaking") return;
        const stored = localStorage.getItem(resumeMatchKey);
        if (stored && currentMatchId !== null && stored === String(currentMatchId)) {
            localStorage.removeItem(resumeMatchKey);
            localStorage.removeItem(resumeMatchModeKey);
            localStorage.removeItem(resumeMatchSourceKey);
        }
    };
    const refreshRoute = () => {
        window.dispatchEvent(new Event("app:route-refresh"));
    };
    const refreshTournamentView = () => {
        if (source !== "tournament") return;
        const currentHash = window.location.hash || "#home";
        if (currentHash === returnHash) {
            refreshRoute();
        }
    };
    const pushGameHistory = () => {
        if (historyPushed) return;
        try {
            history.pushState({ inGame: true, returnHash }, "", window.location.href);
            historyPushed = true;
        } catch {
            // ignore history errors (e.g., Safari private mode)
        }
    };
    const handleReturn = () => {
        if (returnTriggered) return;
        returnTriggered = true;
        teardown();
        const targetHash = returnHash || "#home";
        const currentHash = window.location.hash || "#home";
        if (currentHash !== targetHash) {
            window.location.hash = targetHash;
            return;
        }
        refreshRoute();
    };
    const handleNavigationAway = () => {
        if (returnTriggered) return;
        returnTriggered = true;
        teardown();
        const currentHash = window.location.hash || "#home";
        if (currentHash === returnHash) {
            refreshRoute();
        }
    };
    window.addEventListener("hashchange", handleNavigationAway);
    window.addEventListener("popstate", handleNavigationAway);

    // ---------------------------
    // Remote matchmaking + WS
    // ---------------------------
    if (!isLocal) {
        let matchId: number | null = options.matchId ?? null;

        if (!matchId) {
            const joinUrl = remoteMode === "duo" ? "/api/join-duo" : "/api/join-quad";
            const statusUrl = remoteMode === "duo" ? "/api/join-duo/status" : "/api/join-quad/status";
            const cancelUrl = remoteMode === "duo" ? "/api/join-duo/cancel" : "/api/join-quad/cancel";

            await fetch(joinUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({ userId: currentUserId }),
            });

            // Poll for match with timeout
            const start = Date.now();
            while (!matchId && Date.now() - start < 20000) {
                const res = await fetch(`${statusUrl}?userId=${currentUserId}`, {
                    headers: {
                        ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    },
                });
                const data = await res.json();
                if (data.status === "matched") {
                    matchId = data.matchId;
                } else {
                    await wait(1000);
                }
            }

            if (!matchId) {
                await fetch(cancelUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    },
                    body: JSON.stringify({ userId: currentUserId }),
                });
                container.innerHTML = "<p class='text-red-500 text-center mt-8'>Matchmaking cancelled (timeout)</p>";
                window.removeEventListener("keydown", keydownHandler);
                window.removeEventListener("keyup", keyupHandler);
                return;
            }
        }

        // Match found, build full-screen UI
        ({
            overlay,
            wrapper,
            canvas,
            ctx,
            scoreBox,
            statusBox,
            messagesList,
            chatForm,
            chatInput,
        } = buildUI(container, !isLocal));
        applyControlsHint(wrapper, isQuad, isLocal);
        pushGameHistory();

        currentMatchId = matchId;
        storeResumeMatch(matchId);
    
        if (!isLocal) {
            readyButton = document.createElement("button");
            readyButton.textContent = "Connecting...";
            readyButton.style.position = "absolute";
            readyButton.style.left = "50%";
            readyButton.style.bottom = "24px";
            readyButton.style.transform = "translateX(-50%)";
            readyButton.style.padding = "10px 18px";
            readyButton.style.borderRadius = "10px";
            readyButton.style.border = "none";
            readyButton.style.background = "#2563eb";
            readyButton.style.color = "#fff";
            readyButton.style.fontWeight = "700";
            readyButton.style.boxShadow = "0 6px 12px rgba(0,0,0,0.15)";
            readyButton.disabled = true;
            readyButton.addEventListener("click", (e) => {
                e.preventDefault();
                if (!matchStarted || isPaused) {
                    sendReady();
                } else if (servePending && myPaddleIndex === serverIndex) {
                    sendServe();
                }
            });
            wrapper.appendChild(readyButton);
            setStatus("Connecting to match...");
        }

        const useSecure = window.location.protocol === "https:";
        gameSocket = io("/game", {
            transports: ["polling", "websocket"],
            auth: { userId: currentUserId, matchId, token, username: me.username },
            withCredentials: true,
            secure: useSecure,
        });

        gameSocket.on("connect", () => {
            if (readyButton) {
                readyButton.disabled = false;
                readyButton.textContent = "I'm ready";
            }
            if (!isReady) {
                setStatus('Match found! Press "Space" or click "I’m ready" to launch.');
            }
            if (pendingReady && !isReady) {
                pendingReady = false;
                sendReady();
            }
            updateServeUI();
        });

        gameSocket.on("connect_error", (err) => {
            console.error("Game socket connect_error:", err);
            if (readyButton) {
                readyButton.disabled = true;
                readyButton.textContent = "Connecting...";
            }
            if (err?.message?.includes("Unauthorized") || err?.message?.includes("Forbidden")) {
                setStatus("Connection refused. Please log in again.");
                alert("Unable to join the game (auth error). Please log in again.");
            } else {
                setStatus("Connection error. Retrying...");
            }
        });

        gameSocket.on("error", (err: any) => {
            console.error("Game socket error event:", err);
            const msg = err?.message || "Connection error";
            setStatus(msg);
            if (readyButton) {
                readyButton.disabled = true;
                readyButton.textContent = "Connecting...";
            }
        });

        gameSocket.on("identify", ({ index }) => {
            myPaddleIndex = index;
        });

        gameSocket.on("state", (msg: any) => {
            if (msg.names) nameLabels = { ...(nameLabels || {}), ...msg.names };
            if (msg.config) {
                config = { ...config, ...msg.config };
                canvas.width = config.width;
                canvas.height = config.height;
            }

            // Ball updates come from server
            state.ball.x = msg.state.ball.x;
            state.ball.y = msg.state.ball.y;
            state.ball.vx = msg.state.ball.vx;
            state.ball.vy = msg.state.ball.vy;

            // Reconcile paddles: do not overwrite local paddle (client prediction); softly interpolate others
            const myPaddleKey = `p${myPaddleIndex}` as keyof PaddleState;
            const newPaddles = { ...state.paddles };

            const forceAll = servePending || !matchStarted;
            // Update all paddles; for my paddle we force on serve to avoid drift
            (Object.keys(msg.state.paddles) as Array<keyof PaddleState>).forEach((key) => {
                const serverValue = msg.state.paddles[key] as number;
                const currentValue = state.paddles[key] as number;
                if (forceAll || key !== myPaddleKey) {
                    newPaddles[key] = forceAll ? serverValue : (currentValue + (serverValue - currentValue) * 0.3 as any);
                }
            });

            state.paddles = newPaddles;
            scores = msg.scores;
            renderScores(scoreBox, scores, isQuad, undefined, nameLabels || msg.names);
        });


        gameSocket.on("ready", (msg: any) => {
            if (msg?.readyIds?.includes(currentUserId)) {
                isReady = true;
                if (readyButton) {
                    readyButton.disabled = true;
                    readyButton.textContent = "Ready";
                }
            }
            if (msg?.total) {
                setStatus(`Ready: ${msg.readyCount ?? 0}/${msg.total}`);
            }
        });

        gameSocket.on("countdown", (msg: any) => {
            matchStarted = false;
            setStatus(`Starting in ${msg.seconds}s`);
            if (readyButton) readyButton.disabled = true;
        });

        gameSocket.on("start", (msg: any) => {
            matchStarted = true;
            isReady = true;
            servePending = !!msg?.waitServe;
            serverIndex = msg?.server ?? serverIndex ?? 1;
            if (msg?.names) nameLabels = { ...(nameLabels || {}), ...msg.names };
            if (msg?.state) {
                state.ball = msg.state.ball;
                state.paddles = msg.state.paddles;
                scores = msg.scores || scores;
                renderScores(scoreBox, scores, isQuad, undefined, nameLabels || msg.names);
            }
            if (servePending) {
                setStatus("Waiting for serve...");
                updateServeUI();
            } else {
                setStatus("GO !");
                if (readyButton) readyButton.style.display = "none";
                setTimeout(() => setStatus(""), 1200);
            }
        });

        gameSocket.on("waitServe", (msg: any) => {
            servePending = true;
            serverIndex = msg?.server ?? serverIndex ?? 1;
            updateServeUI();
        });

        gameSocket.on("serve", (msg: any) => {
            servePending = false;
            setStatus("GO !");
            if (readyButton) readyButton.style.display = "none";
            setTimeout(() => setStatus(""), 800);
        });

        // Dedicated event for ball updates (60 FPS)
        gameSocket.on("ball", (msg: any) => {
            if (msg.ball) {
                state.ball.x = msg.ball.x;
                state.ball.y = msg.ball.y;
                state.ball.vx = msg.ball.vx;
                state.ball.vy = msg.ball.vy;
            }
        });

        gameSocket.on("end", async (msg: any) => {
            if (matchEnded) return;
            matchEnded = true;
            running = false;
            matchStarted = false;
            if (msg?.names) nameLabels = { ...(nameLabels || {}), ...msg.names };
            renderScores(scoreBox, scores, isQuad, msg?.winner || "END", nameLabels || msg?.names);
            try {
                if (options.onEnd) await options.onEnd({ winner: msg?.winner, scores });
            } catch (err) {
                console.error("onEnd handler failed:", err);
            }
            refreshTournamentView();
            clearResumeMatch();
            showReturnOverlay(handleReturn);
        });

        gameSocket.on("pause", () => {
            isPaused = true;
            isReady = false;
            setStatus("Opponent disconnected. Press Ready to resume when they return.");
            servePending = true;
            updateServeUI();
        });

        gameSocket.on("resume", () => {
            isPaused = false;
            setStatus("Opponent reconnected. Resuming...");
            updateServeUI();
            setTimeout(() => setStatus(""), 1500);
        });

        // Send paddle moves with client prediction
        paddleInterval = window.setInterval(() => {
            if (!gameSocket || !myPaddleIndex) return;
            if (!matchStarted || isPaused) return;
            const payload: any = { type: "paddle" };
            const speed = config.paddleSpeed;
            const paddleLen = config.paddleLength;

            // Helper to keep paddle values within bounds
            const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));

            let moved = false;

            // Client prediction: immediate local update
            if (myPaddleIndex === 1) {
                let newValue = state.paddles.p1;
                if (keys.has("w")) { newValue -= speed; moved = true; }
                if (keys.has("s")) { newValue += speed; moved = true; }
                if (moved) {
                    // Clamp and update locally
                    newValue = clamp(newValue, paddleLen / 2, config.height - paddleLen / 2);
                    state.paddles.p1 = newValue;
                    payload.value = newValue;
                    payload.axis = "y";
                }
            }
            if (myPaddleIndex === 2) {
                let newValue = state.paddles.p2;
                if (keys.has("ArrowUp")) { newValue -= speed; moved = true; }
                if (keys.has("ArrowDown")) { newValue += speed; moved = true; }
                if (moved) {
                    // Clamp and update locally
                    newValue = clamp(newValue, paddleLen / 2, config.height - paddleLen / 2);
                    state.paddles.p2 = newValue;
                    payload.value = newValue;
                    payload.axis = "y";
                }
            }
            if (myPaddleIndex === 3 && isQuad) {
                let newValue = state.paddles.p3 ?? 0;
                if (keys.has("a")) { newValue -= speed; moved = true; }
                if (keys.has("d")) { newValue += speed; moved = true; }
                if (moved) {
                    // Clamp and update locally
                    newValue = clamp(newValue, paddleLen / 2, config.width - paddleLen / 2);
                    state.paddles.p3 = newValue;
                    payload.value = newValue;
                    payload.axis = "x";
                }
            }
            if (myPaddleIndex === 4 && isQuad) {
                let newValue = state.paddles.p4 ?? 0;
                if (keys.has("j")) { newValue -= speed; moved = true; }
                if (keys.has("l")) { newValue += speed; moved = true; }
                if (moved) {
                    // Clamp and update locally
                    newValue = clamp(newValue, paddleLen / 2, config.width - paddleLen / 2);
                    state.paddles.p4 = newValue;
                    payload.value = newValue;
                    payload.axis = "x";
                }
            }

            // Only emit if the player moved
            if (payload.value !== undefined && moved) {
                gameSocket.emit("paddle", payload);
            }
        }, 1000 / 60);

        // Init chat
        if (messagesList && chatForm && chatInput) {
            initMatchChat(matchId, messagesList);
            setupChatForm(chatForm, chatInput);
        }
    }
    // Local modes: build UI immediately
    else {
        ({
            overlay,
            wrapper,
            canvas,
            ctx,
            scoreBox,
            statusBox,
            messagesList,
            chatForm,
            chatInput,
        } = buildUI(container, false));
        applyControlsHint(wrapper, isQuad, isLocal);
        pushGameHistory();
    }

    // ---------------------------
    // Local game loop
    // ---------------------------
    let lastTime = performance.now();
    let localServe = { pending: isLocal }; // wait for serve in local modes
    renderScores(scoreBox, scores, isQuad, undefined, nameLabels);

    function loop(ts: number) {
        const dt = (ts - lastTime) / 1000;
        lastTime = ts;

        if (isLocal) {
            stepLocal(state, scores, keys, config, isQuad, dt, localServe, () => {
                if (matchEnded) return;
                matchEnded = true;
                running = false;
                const winner = findLocalWinner(scores);
                renderScores(scoreBox, scores, isQuad, winner, nameLabels);
                options.onEnd?.({ winner, scores });
                showReturnOverlay(handleReturn);
            });
            renderScores(scoreBox, scores, isQuad, undefined, nameLabels);
        }

        draw(ctx, canvas, state, config, isQuad);

        if (running) requestAnimationFrame(loop);
    }

    requestAnimationFrame(loop);

    function teardown() {
        if (paddleInterval) {
            clearInterval(paddleInterval);
            paddleInterval = null;
        }
        if (gameSocket) {
            gameSocket.off();
            gameSocket.disconnect();
            gameSocket = null;
        }
        if (chatSocket) {
            chatSocket.off();
            chatSocket.disconnect();
            chatSocket = null;
        }
        if (overlay && overlay.parentElement) {
            overlay.parentElement.removeChild(overlay);
            overlay = null;
        }
        const returnOverlay = document.getElementById("match-return-overlay");
        if (returnOverlay) returnOverlay.remove();
        window.removeEventListener("hashchange", handleNavigationAway);
        window.removeEventListener("popstate", handleNavigationAway);
        window.removeEventListener("keydown", keydownHandler);
        window.removeEventListener("keyup", keyupHandler);
        (window as any).stopCurrentGame = undefined;
    }

    // expose teardown for external navigation (e.g., Home button)
    (window as any).stopCurrentGame = teardown;
}

// ---------------------------
// Local physics
// ---------------------------
function stepLocal(
    state: ClientState,
    scores: Record<string, number>,
    keys: Set<string>,
    config: GameConfig,
    isQuad: boolean,
    dt: number,
    serveCtrl: { pending: boolean },
    onEnd: () => void
) {
    const speed = config.paddleSpeed;
    // If waiting for serve, keep ball stopped until space/enter pressed
    if (serveCtrl.pending) {
        state.ball.vx = 0;
        state.ball.vy = 0;
        state.ball.x = config.width / 2;
        state.ball.y = config.height / 2;
        if (keys.has(" ") || keys.has("Enter")) {
            serveCtrl.pending = false;
            resetLocalBall(state, config);
        }
    }

    // Input mapping for local keyboard players
    if (keys.has("w")) state.paddles.p1 -= speed;
    if (keys.has("s")) state.paddles.p1 += speed;
    if (keys.has("ArrowUp")) state.paddles.p2 -= speed;
    if (keys.has("ArrowDown")) state.paddles.p2 += speed;
    if (isQuad) {
        if (keys.has("a")) state.paddles.p3! -= speed;
        if (keys.has("d")) state.paddles.p3! += speed;
        if (keys.has("j")) state.paddles.p4! -= speed;
        if (keys.has("l")) state.paddles.p4! += speed;
    }

    // Clamp paddles
    state.paddles.p1 = clamp(state.paddles.p1, config.paddleLength / 2, config.height - config.paddleLength / 2);
    state.paddles.p2 = clamp(state.paddles.p2, config.paddleLength / 2, config.height - config.paddleLength / 2);
    if (isQuad) {
        state.paddles.p3 = clamp(state.paddles.p3!, config.paddleLength / 2, config.width - config.paddleLength / 2);
        state.paddles.p4 = clamp(state.paddles.p4!, config.paddleLength / 2, config.width - config.paddleLength / 2);
    }

    // Move ball
    const b = state.ball;
    if (b.vx === 0 && b.vy === 0 && !serveCtrl.pending) {
        resetLocalBall(state, config);
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Walls (top/bottom) only duo
    if (!isQuad) {
        if (b.y - config.ballRadius < 0) {
            b.y = config.ballRadius;
            b.vy *= -1;
        }
        if (b.y + config.ballRadius > config.height) {
            b.y = config.height - config.ballRadius;
            b.vy *= -1;
        }
    }

    // Paddles collisions
    // Left paddle (p1)
    if (b.x - config.ballRadius < config.paddleThickness + 20) {
        const minY = state.paddles.p1 - config.paddleLength / 2;
        const maxY = state.paddles.p1 + config.paddleLength / 2;
        if (b.y >= minY && b.y <= maxY) {
            b.x = config.paddleThickness + 20 + config.ballRadius;
            b.vx = Math.abs(b.vx);
        }
    }
    // Right paddle (p2)
    if (b.x + config.ballRadius > config.width - (config.paddleThickness + 20)) {
        const minY = state.paddles.p2 - config.paddleLength / 2;
        const maxY = state.paddles.p2 + config.paddleLength / 2;
        if (b.y >= minY && b.y <= maxY) {
            b.x = config.width - (config.paddleThickness + 20) - config.ballRadius;
            b.vx = -Math.abs(b.vx);
        }
    }

    if (isQuad) {
        if (b.y - config.ballRadius < config.paddleThickness + 20) {
            const minX = (state.paddles.p3 ?? 0) - config.paddleLength / 2;
            const maxX = (state.paddles.p3 ?? 0) + config.paddleLength / 2;
            if (b.x >= minX && b.x <= maxX) {
                b.y = config.paddleThickness + 20 + config.ballRadius;
                b.vy = Math.abs(b.vy);
            }
        }
        if (b.y + config.ballRadius > config.height - (config.paddleThickness + 20)) {
            const minX = (state.paddles.p4 ?? 0) - config.paddleLength / 2;
            const maxX = (state.paddles.p4 ?? 0) + config.paddleLength / 2;
            if (b.x >= minX && b.x <= maxX) {
                b.y = config.height - (config.paddleThickness + 20) - config.ballRadius;
                b.vy = -Math.abs(b.vy);
            }
        }
    }

    // Goals
    if (b.x < 0) {
        scores.p2 += 1;
        serveCtrl.pending = true;
        state.ball.x = config.width / 2;
        state.ball.y = config.height / 2;
        state.ball.vx = 0;
        state.ball.vy = 0;
    } else if (b.x > config.width) {
        scores.p1 += 1;
        serveCtrl.pending = true;
        state.ball.x = config.width / 2;
        state.ball.y = config.height / 2;
        state.ball.vx = 0;
        state.ball.vy = 0;
    } else if (isQuad && b.y < 0) {
        scores.p4! += 1;
        serveCtrl.pending = true;
        state.ball.x = config.width / 2;
        state.ball.y = config.height / 2;
        state.ball.vx = 0;
        state.ball.vy = 0;
    } else if (isQuad && b.y > config.height) {
        scores.p3! += 1;
        serveCtrl.pending = true;
        state.ball.x = config.width / 2;
        state.ball.y = config.height / 2;
        state.ball.vx = 0;
        state.ball.vy = 0;
    }

    if (checkWin(scores)) {
        onEnd();
    }
}

function resetLocalBall(state: ClientState, config: GameConfig) {
    const dirX = Math.random() > 0.5 ? 1 : -1;
    const dirY = Math.random() > 0.5 ? 1 : -1;
    state.ball.x = config.width / 2;
    state.ball.y = config.height / 2;
    state.ball.vx = 300 * dirX;
    state.ball.vy = 200 * dirY;
}

function checkWin(scores: Record<string, number>) {
    return Object.values(scores).some((v) => v >= 10);
}

function findLocalWinner(scores: Record<string, number>) {
    let bestKey = "";
    let bestScore = -1;
    for (const [k, v] of Object.entries(scores)) {
        if (v > bestScore) {
            bestScore = v;
            bestKey = k;
        }
    }
    return bestKey || undefined;
}

// ---------------------------
// Drawing
// ---------------------------
function draw(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, state: ClientState, config: GameConfig, isQuad: boolean) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Ball
    ctx.beginPath();
    ctx.arc(state.ball.x, state.ball.y, config.ballRadius, 0, Math.PI * 2);
    ctx.fillStyle = "black";
    ctx.fill();

    // Player 1 paddle
    ctx.fillRect(20, state.paddles.p1 - config.paddleLength / 2, config.paddleThickness, config.paddleLength);

    // Player 2 paddle
    ctx.fillRect(canvas.width - 20 - config.paddleThickness, state.paddles.p2 - config.paddleLength / 2, config.paddleThickness, config.paddleLength);

    if (isQuad) {
        // Player 3 top horizontal
        ctx.fillRect((state.paddles.p3 ?? 0) - config.paddleLength / 2, 20, config.paddleLength, config.paddleThickness);

        // Player 4 bottom horizontal
        ctx.fillRect((state.paddles.p4 ?? 0) - config.paddleLength / 2, canvas.height - 20 - config.paddleThickness, config.paddleLength, config.paddleThickness);
    }
}

function renderScores(el: HTMLElement, scores: Record<string, number>, isQuad: boolean, winner?: string, names?: Record<string, string>) {
    const labels = {
        p1: names?.p1 || "P1",
        p2: names?.p2 || "P2",
        p3: names?.p3 || "P3",
        p4: names?.p4 || "P4",
    };
    const winnerLabel = winner ? (labels[winner as keyof typeof labels] || winner) : undefined;
    if (winnerLabel) {
        el.textContent = `Winner: ${winnerLabel} | ${formatScores(scores, isQuad, labels)}`;
    } else {
        el.textContent = formatScores(scores, isQuad, labels);
    }
}

function formatScores(scores: Record<string, number>, isQuad: boolean, labels: Record<string, string>) {
    if (isQuad) {
        return `${labels.p1}: ${scores.p1 ?? 0} | ${labels.p2}: ${scores.p2 ?? 0} | ${labels.p3}: ${scores.p3 ?? 0} | ${labels.p4}: ${scores.p4 ?? 0}`;
    }
    return `${labels.p1}: ${scores.p1 ?? 0} | ${labels.p2}: ${scores.p2 ?? 0}`;
}

// ---------------------------
// UI helper (fullscreen)
// ---------------------------
function buildUI(
    container: HTMLElement,
    withChat: boolean
): {
    overlay: HTMLDivElement;
    wrapper: HTMLDivElement;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    scoreBox: HTMLDivElement;
    statusBox: HTMLDivElement;
    messagesList: HTMLUListElement | null;
    chatForm: HTMLFormElement | null;
    chatInput: HTMLInputElement | null;
} {
    container.innerHTML = "";
    const header = document.getElementById("header1-section");
    let headerH = header ? header.getBoundingClientRect().height : 80;
    if (!headerH || headerH < 40) headerH = 80;

    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.top = `${headerH}px`;
    overlay.style.left = "0";
    overlay.style.width = "100vw";
    overlay.style.height = `calc(100vh - ${headerH}px)`;
    overlay.style.zIndex = "40"; // keep header (z=50) visible, but above page content
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.background = "linear-gradient(135deg, #f4f4f5, #e5e7eb)";
    document.body.appendChild(overlay);

    const wrapper = document.createElement("div");
    wrapper.style.position = "relative";
    wrapper.style.width = "100%";
    wrapper.style.height = "100%";
    wrapper.style.display = "flex";
    wrapper.style.alignItems = "center";
    wrapper.style.justifyContent = "center";
    wrapper.style.borderRadius = "12px";
    wrapper.style.boxShadow = "0 10px 30px rgba(0,0,0,0.08)";
    overlay.appendChild(wrapper);

    const canvas = document.createElement("canvas");
    canvas.width = DEFAULT_CONFIG.width;
    canvas.height = DEFAULT_CONFIG.height;
    canvas.style.border = "1px solid #ccc";
    canvas.style.background = "#fff";
    canvas.style.width = "min(95vw, 95vh)";
    canvas.style.height = "min(95vw, 95vh)";
    canvas.style.maxWidth = "1200px";
    canvas.style.maxHeight = "1200px";
    wrapper.appendChild(canvas);
    const ctx = canvas.getContext("2d")!;

    const scoreBox = document.createElement("div");
    scoreBox.style.position = "absolute";
    scoreBox.style.top = "16px";
    scoreBox.style.left = "50%";
    scoreBox.style.transform = "translateX(-50%)";
    scoreBox.style.background = "rgba(0,0,0,0.7)";
    scoreBox.style.color = "#fff";
    scoreBox.style.padding = "8px 12px";
    scoreBox.style.borderRadius = "8px";
    scoreBox.style.fontWeight = "bold";
    scoreBox.style.fontSize = "14px";
    wrapper.appendChild(scoreBox);

    const statusBox = document.createElement("div");
    statusBox.style.position = "absolute";
    statusBox.style.top = "52px";
    statusBox.style.left = "50%";
    statusBox.style.transform = "translateX(-50%)";
    statusBox.style.background = "rgba(17,24,39,0.85)";
    statusBox.style.color = "#fff";
    statusBox.style.padding = "6px 10px";
    statusBox.style.borderRadius = "8px";
    statusBox.style.fontSize = "13px";
    statusBox.style.fontWeight = "600";
    statusBox.style.pointerEvents = "none";
    wrapper.appendChild(statusBox);

    const controlsBox = document.createElement("div");
    controlsBox.id = "pong-controls";
    controlsBox.style.position = "absolute";
    controlsBox.style.left = "16px";
    controlsBox.style.bottom = "16px";
    controlsBox.style.background = "rgba(17,24,39,0.85)";
    controlsBox.style.color = "#e5e7eb";
    controlsBox.style.padding = "8px 10px";
    controlsBox.style.borderRadius = "8px";
    controlsBox.style.fontSize = "12px";
    controlsBox.style.fontWeight = "600";
    controlsBox.style.maxWidth = "320px";
    controlsBox.style.lineHeight = "1.3";
    wrapper.appendChild(controlsBox);

    let messagesList: HTMLUListElement | null = null;
    let chatForm: HTMLFormElement | null = null;
    let chatInput: HTMLInputElement | null = null;

    if (withChat) {
        const chatWrapper = document.createElement("div");
        chatWrapper.style.position = "absolute";
        chatWrapper.style.right = "20px";
        chatWrapper.style.bottom = "20px";
        chatWrapper.style.width = "300px";
        chatWrapper.style.maxHeight = "320px";
        chatWrapper.style.background = "rgba(0,0,0,0.6)";
        chatWrapper.style.color = "#fff";
        chatWrapper.style.borderRadius = "10px";
        chatWrapper.style.padding = "10px";
        chatWrapper.style.display = "flex";
        chatWrapper.style.flexDirection = "column";
        chatWrapper.style.fontSize = "12px";
        chatWrapper.style.backdropFilter = "blur(6px)";

        messagesList = document.createElement("ul");
        messagesList.id = "pong-chat-messages";
        messagesList.style.listStyle = "none";
        messagesList.style.margin = "0 0 8px 0";
        messagesList.style.padding = "0";
        messagesList.style.overflowY = "auto";
        messagesList.style.maxHeight = "220px";

        chatForm = document.createElement("form");
        chatForm.id = "pong-chat-form";
        chatForm.style.display = "flex";
        chatForm.style.gap = "6px";

        chatInput = document.createElement("input");
        chatInput.id = "pong-chat-input";
        chatInput.type = "text";
        chatInput.placeholder = "Type your message...";
        chatInput.autocomplete = "off";
        chatInput.style.flex = "1";
        chatInput.style.color = "#111";

        const btn = document.createElement("button");
        btn.type = "submit";
        btn.textContent = "Send";
        btn.style.background = "#22c55e";
        btn.style.color = "#fff";
        btn.style.padding = "6px 10px";
        btn.style.borderRadius = "6px";

        chatForm.appendChild(chatInput);
        chatForm.appendChild(btn);
        chatWrapper.appendChild(messagesList);
        chatWrapper.appendChild(chatForm);
        wrapper.appendChild(chatWrapper);
    }

    return { overlay, wrapper, canvas, ctx, scoreBox, statusBox, messagesList, chatForm, chatInput };
}

function applyControlsHint(wrapper: HTMLDivElement, isQuad: boolean, isLocal: boolean) {
    const controlsBox = wrapper.querySelector<HTMLDivElement>("#pong-controls");
    if (!controlsBox) return;
    const base = isQuad
        ? "Controls: P1 W/S, P2 Up/Down, P3 A/D, P4 J/L."
        : "Controls: P1 W/S, P2 Up/Down.";
    const extra = isLocal
        ? " Press Space or Enter to serve."
        : " Press Space or Enter, or click Ready to start/serve.";
    controlsBox.textContent = base + extra;
}

function showReturnOverlay(onReturn: () => void, delaySeconds: number = 5) {
    const existing = document.getElementById("match-return-overlay");
    existing?.remove();

    const overlay = document.createElement("div");
    overlay.id = "match-return-overlay";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.7)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = "70";

    const box = document.createElement("div");
    box.style.background = "#0f172a";
    box.style.color = "#e5e7eb";
    box.style.padding = "24px";
    box.style.borderRadius = "12px";
    box.style.boxShadow = "0 12px 30px rgba(0,0,0,0.35)";
    box.style.textAlign = "center";
    box.style.minWidth = "260px";

    const title = document.createElement("h3");
    title.textContent = "Match finished";
    title.style.fontSize = "18px";
    title.style.marginBottom = "8px";
    title.style.fontWeight = "700";
    box.appendChild(title);

    const subtitle = document.createElement("p");
    subtitle.textContent = "Great game! You will be sent back to the menu.";
    subtitle.style.margin = "0 0 12px";
    subtitle.style.fontSize = "14px";
    subtitle.style.color = "#cbd5e1";
    box.appendChild(subtitle);

    const countdown = document.createElement("p");
    countdown.style.margin = "0 0 16px";
    countdown.style.fontWeight = "600";
    countdown.style.color = "#e2e8f0";
    box.appendChild(countdown);

    let remaining = delaySeconds;
    let timer: number | null = null;
    let hardTimeout: number | null = null;
    const deadline = Date.now() + delaySeconds * 1000;
    const tick = () => {
        remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        countdown.textContent = `Returning in ${remaining}s`;
    };

    const cleanup = () => {
        if (timer !== null) {
            window.clearInterval(timer);
            timer = null;
        }
        if (hardTimeout !== null) {
            window.clearTimeout(hardTimeout);
            hardTimeout = null;
        }
        overlay.remove();
        onReturn?.();
    };

    const btn = document.createElement("button");
    btn.textContent = "Return to the menu";
    btn.style.padding = "10px 16px";
    btn.style.background = "#22c55e";
    btn.style.color = "#0b1224";
    btn.style.border = "none";
    btn.style.borderRadius = "10px";
    btn.style.fontWeight = "700";
    btn.style.cursor = "pointer";
    btn.addEventListener("click", () => cleanup());
    box.appendChild(btn);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    tick();
    timer = window.setInterval(() => {
        tick();
        if (remaining <= 0) cleanup();
    }, 1000);
    hardTimeout = window.setTimeout(() => cleanup(), delaySeconds * 1000 + 200);
}

// ---------------------------
// Chat helpers
// ---------------------------
function renderChatMessage(
    msg: { from: number; fromUsername?: string; text: string; at: string },
    messagesList: HTMLUListElement
) {
    // Prevent duplicates (same sender + same text + timestamp)
    const dedupKey = `${msg.from}|${msg.text}|${msg.at}`;
    const seen = ((messagesList as any)._seenKeys ??= new Set<string>());
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);

    const li = document.createElement("li");
    const time = new Date(msg.at).toLocaleTimeString();
    const label = msg.fromUsername || `#${msg.from}`;

    const timeSpan = document.createElement("span");
    timeSpan.textContent = `[${time}] `;
    li.appendChild(timeSpan);

    if (Number.isFinite(msg.from)) {
        const link = document.createElement("button");
        link.type = "button";
        link.textContent = label;
        link.style.color = "#a5b4fc";
        link.style.textDecoration = "underline";
        link.style.cursor = "pointer";
        link.style.background = "transparent";
        link.style.border = "none";
        link.addEventListener("click", (e) => {
            e.stopPropagation();
            sessionStorage.setItem("profileUserId", String(msg.from));
            if ((window as any).stopCurrentGame) {
                try { (window as any).stopCurrentGame(); } catch { /* ignore */ }
            }
            window.location.hash = "#profile";
            try {
                window.dispatchEvent(new HashChangeEvent("hashchange"));
            } catch {
                /* ignore */
            }
        });
        li.appendChild(link);
    } else {
        const nameSpan = document.createElement("span");
        nameSpan.textContent = label;
        li.appendChild(nameSpan);
    }

    const textSpan = document.createElement("span");
    textSpan.textContent = `: ${msg.text}`;
    li.appendChild(textSpan);

    // Quick block action
    const me = JSON.parse(sessionStorage.getItem("me") || localStorage.getItem("me") || "{}");
    const myId = Number(me?.id);
    if (Number.isFinite(msg.from) && msg.from !== myId) {
        const blockBtn = document.createElement("button");
        blockBtn.type = "button";
        blockBtn.textContent = "Block";
        blockBtn.style.marginLeft = "8px";
        blockBtn.style.fontSize = "11px";
        blockBtn.style.padding = "2px 6px";
        blockBtn.style.borderRadius = "8px";
        blockBtn.style.border = "none";
        blockBtn.style.background = "#ef4444";
        blockBtn.style.color = "#fff";
        blockBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!confirm(`Block ${label}? They will no longer be able to chat with you.`)) return;
            try {
                await blockFriend(msg.from);
                const muted = document.createElement("span");
                muted.style.marginLeft = "6px";
                muted.style.color = "#94a3b8";
                muted.textContent = "(blocked)";
                li.appendChild(muted);
            } catch (err: any) {
                alert(err?.message || "Failed to block user.");
            }
        });
        li.appendChild(blockBtn);
    }

    messagesList.appendChild(li);
    messagesList.scrollTop = messagesList.scrollHeight;
}

function initMatchChat(matchId: number, messagesList: HTMLUListElement) {
    // Prevent duplicate sockets
    if (chatSocket) {
        chatSocket.disconnect();
        chatSocket = null;
    }

    const token = localStorage.getItem("jwt") || sessionStorage.getItem("token");
    if (!token) {
        const li = document.createElement("li");
        li.textContent = "Chat unavailable (no token)";
        messagesList.appendChild(li);
        return;
    }

    chatSocket = io(window.location.origin, {
        transports: ["polling"],
        auth: { token },
        withCredentials: true,
    });

    let errorShown = false;
    chatSocket.on("connect_error", (err) => {
        if (errorShown) return;
        errorShown = true;
        renderChatMessage(
            { from: -1, text: `Chat error: ${err.message}`, at: new Date().toISOString() },
            messagesList
        );
    });

    chatSocket.on("connect", () => {
        chatSocket?.emit("joinMatchChat", matchId);
    });

    chatSocket.emit("joinMatchChat", matchId);

    chatSocket.on("chat:message", (msg: { from: number; fromUsername?: string; text: string; at: string }) => {
        renderChatMessage(msg, messagesList);
    });

}

function setupChatForm(form: HTMLFormElement, input: HTMLInputElement) {
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        if (!chatSocket || currentMatchId == null) {
            console.warn("Chat socket not connected");
            return;
        }
        const safeText = text.slice(0, 500);

        chatSocket.emit("chat:message", {
            matchId: currentMatchId,
            text: safeText,
        });

        input.value = "";
    });
}

// ---------------------------
// Utils
// ---------------------------
function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
