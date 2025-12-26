import { request } from "./api";

const normalizeAvatar = (url?: string) => {
    if (!url) return "/uploads/default.png";
    if (url.startsWith("http")) return url;
    return url.startsWith("/uploads/") ? url : `/uploads/${url}`;
};

function formatDate(dateStr: string) {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleString();
}

export async function renderMatches(app: HTMLElement) {
    app.innerHTML = `<h1 class="text-2xl font-bold mb-4 text-gray-800 dark:text-gray-100">Recent Matches (all players)</h1>`;

    try {
        const res = await request("/user/matches");
        const matches = res.matches || [];

        if (!matches.length) {
            app.innerHTML += `<p class="text-gray-500">No matches yet.</p>`;
            return;
        }

        app.innerHTML += matches
            .map(
                (m: any) => `
            <div class="p-3 border rounded mb-3 bg-white dark:bg-gray-800 shadow-sm">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-3">
                        <img src="${normalizeAvatar(m.user_avatar)}" class="h-10 w-10 rounded-full border object-cover" alt="${m.user_name}">
                        <div>
                            <div class="font-semibold text-gray-800 dark:text-gray-100">${m.user_name}</div>
                            <div class="text-xs text-gray-500">${formatDate(m.date)}</div>
                        </div>
                    </div>
                    <div class="text-lg font-bold text-gray-800 dark:text-gray-100">${m.user_score} - ${m.opponent_score}</div>
                    <div class="flex items-center gap-3">
                        <div class="text-right">
                            <div class="font-semibold text-gray-800 dark:text-gray-100">${m.opponent_name}</div>
                        </div>
                        <img src="${normalizeAvatar(m.opponent_avatar)}" class="h-10 w-10 rounded-full border object-cover" alt="${m.opponent_name}">
                    </div>
                </div>
            </div>
        `
            )
            .join("");
    } catch (err: any) {
        app.innerHTML += `<p class="text-red-500">${err.message || "Failed to load matches."}</p>`;
    }
}
