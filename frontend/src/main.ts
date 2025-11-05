import { showHome } from "./pong";
import { showTournament } from "./tournament";

const app = document.getElementById("app")!;

function router() {
  const hash = window.location.hash;
  app.innerHTML = "";
  if (!hash || hash === "#home") showHome(app);
  else if (hash === "#tournament") showTournament(app);
  else app.innerHTML = `<p class="text-red-500">Page not found</p>`;
}

document.getElementById("homeBtn")!.onclick = () => (window.location.hash = "#home");
document.getElementById("tournamentBtn")!.onclick = () => (window.location.hash = "#tournament");

window.addEventListener("hashchange", router);
window.addEventListener("load", router);
