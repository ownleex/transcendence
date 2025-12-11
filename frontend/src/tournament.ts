/*
import { fetchPlayers } from "./api";

export async function showTournament(container: HTMLElement) {
  const tournament_id = 1; // Example tournament
  const players = await fetchPlayers(tournament_id);

  const list = document.createElement("ul");
  players.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = p.alias;
    list.appendChild(li);
  });
  container.appendChild(list);

  container.innerHTML += `<p>Next match: ${players[0]?.alias} vs ${players[1]?.alias}</p>`;
}
*/
import { fetchPlayers } from "./api";
import { showGame } from "./pong";

export async function showTournament(container: HTMLElement) {
    const tournament_id = 1;

    const players = await fetchPlayers(tournament_id);

    const list = document.createElement("ul");
    players.forEach((p) => {
        const li = document.createElement("li");
        li.textContent = p.alias;
        list.appendChild(li);
    });
    container.appendChild(list);

    // next match
    const p1 = players[0];
    const p2 = players[1];

    const btn = document.createElement("button");
    btn.textContent = `Start Match: ${p1.alias} vs ${p2.alias}`;
    btn.className = "px-4 py-2 bg-blue-600 text-white rounded-md mt-4";

    btn.onclick = () => {
        container.innerHTML = "";
        showGame(container, "duo");
    };

    container.appendChild(btn);
}
