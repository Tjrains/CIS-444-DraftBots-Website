// AUTH GUARD — redirect to login if not logged in
(function checkAuth() {
  if (!sessionStorage.getItem('loggedIn')) {
    window.location.href = 'login.html';
  }
})();

let games = [];

// --- Sample team data ---
const teams = [
  { name: "Austin Armadillos", city: "Austin", logo: "images/Austin.png", offense: 88, defense: 74 },
  { name: "Portland Stormchasers", city: "Portland", logo: "images/Portland.png", offense: 65, defense: 91 },
  { name: "Nashville High Notes", city: "Nashville", logo: "images/Nashville.png", offense: 79, defense: 80 },
  { name: "New York Empire", city: "New York", logo: "images/New_York.png", offense: 83, defense: 68 },
  { name: "El Paso Desert Wolves", city: "El Paso", logo: "images/El_Paso.png", offense: 92, defense: 55 },
  { name: "Boise Potato Kings", city: "Boise", logo: "images/Boise.png", offense: 60, defense: 87 },
  { name: "Minneapolis Northstars", city: "Minneapolis", logo: "images/Minneapolis.png", offense: 71, defense: 76 },
  { name: "San Diego Sun Rays", city: "San Diego", logo: "images/San_Diego.png", offense: 77, defense: 82 }
];

const API =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.protocol === "file:"
    ? "http://localhost:3000"
    : "https://draftbots.onrender.com";

// State for live updates
let pollTimer = null;
let countdownTimer = null;
let currentDetailGameId = null;
let pollInFlight = false; // prevent overlapping polls

function openTab(tabId, btnElement) {
  document.querySelectorAll(".tab-content").forEach(section => {
    section.classList.remove("active");
  });

  const selected = document.getElementById(tabId);
  if (selected) selected.classList.add("active");

  const gameDetails = document.getElementById("gameDetails");
  if (gameDetails && tabId !== "gameDetails") {
    gameDetails.classList.add("hidden");
    gameDetails.classList.remove("active");
    currentDetailGameId = null;
  }

  document.querySelectorAll(".tab").forEach(btn => btn.classList.remove("active"));
  if (btnElement) btnElement.classList.add("active");
}

async function getProfileData() {
  const username = sessionStorage.getItem('username');
  const response = await fetch(`${API}/api/profile?username=${username}`);

  if (!response.ok) throw new Error("Failed to load profile");
  return await response.json();
}

async function getBetsData() {
  const username = sessionStorage.getItem('username');
  const response = await fetch(`${API}/api/bets?username=${username}`);

  if (!response.ok) throw new Error("Failed to load bets");
  return await response.json();
}

async function getGamesData() {
  const response = await fetch(`${API}/api/games`);

  if (!response.ok) throw new Error("Failed to load games");
  return await response.json();
}

// --- Helpers ---
function formatCountdown(ms) {
  if (ms <= 0) return "00:00";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function splitTeams(gameName) {
  const parts = (gameName || "").split(' vs ');
  return { home: parts[0] || 'Home', away: parts[1] || 'Away' };
}

// What appears on the right of a schedule card.
function renderStatusPill(game) {
  // Live game -> pulsing red countdown showing time left in the game
  if (game.status === 'live' && game.endTime) {
    const endMs = new Date(game.endTime).getTime();
    return `
      <span class="live-pill" data-end="${endMs}" data-game-id="${game.id}">
        <span class="live-pill-dot"></span>
        <span class="countdown-time">${formatCountdown(endMs - Date.now())}</span>
      </span>
    `;
  }

  // Upcoming with a known start time -> blue countdown to lock
  if (game.status === 'upcoming' && game.startTime) {
    const startMs = new Date(game.startTime).getTime();
    const remaining = startMs - Date.now();
    if (remaining > 0) {
      return `
        <span class="countdown-pill" data-start="${startMs}" data-game-id="${game.id}">
          <span class="countdown-time">${formatCountdown(remaining)}</span>
        </span>
      `;
    }
  }

  // Finished with a score -> compact final-score pill
  if (game.status === 'finished' && game.homeScore != null && game.awayScore != null) {
    return `<span class="final-pill">${game.homeScore} - ${game.awayScore}</span>`;
  }

  return `<span class="status-pill ${game.status}">${game.status}</span>`;
}

async function loadGames() {
  const gameList = document.getElementById("gameList");
  if (!gameList) return;

  try {
    games = await getGamesData();
    renderSchedule();
  } catch (err) {
    console.error("Failed to load games:", err);
    gameList.innerHTML = `<p class="empty-msg">Could not load games.</p>`;
  }
}

function renderSchedule() {
  const gameList = document.getElementById("gameList");
  if (!gameList) return;

  gameList.innerHTML = "";
  games.forEach(game => {
    const card = document.createElement("div");
    card.className = "game-card";
    card.onclick = () => showGame(game);

    card.innerHTML = `
      <div class="game-card-left">
        <span class="game-name">${game.name}</span>
        <span class="game-sport">${game.sport || ""}</span>
      </div>
      ${renderStatusPill(game)}
    `;
    gameList.appendChild(card);
  });
}

// What appears at the top of the game-detail view.
function renderGameHeader(game) {
  if (game.status === "finished") {
    if (game.homeScore != null && game.awayScore != null) {
      const { home, away } = splitTeams(game.name);
      return `
        <div class="final-score">
          <div class="final-score-label">Final Score</div>
          <div class="final-score-row">
            <span class="team-name">${home}</span>
            <span class="score">${game.homeScore}</span>
            <span class="dash">—</span>
            <span class="score">${game.awayScore}</span>
            <span class="team-name">${away}</span>
          </div>
        </div>
      `;
    }
    return `<div class="final-score"><div class="final-score-label">Game Finished</div></div>`;
  }

  if (game.status === "live") {
    if (game.endTime) {
      const endMs = new Date(game.endTime).getTime();
      const remaining = endMs - Date.now();
      return `
        <div class="live-indicator" data-end="${endMs}" data-game-id="${game.id}">
          <div class="live-indicator-left">
            <span class="live-dot"></span>
            <span>LIVE NOW · BETTING CLOSED</span>
          </div>
          <div class="live-indicator-right">
            <span class="time-label">Time remaining</span>
            <span class="countdown-time">${formatCountdown(remaining)}</span>
          </div>
        </div>
      `;
    }
    return `
      <div class="live-indicator">
        <div class="live-indicator-left">
          <span class="live-dot"></span>
          <span>LIVE NOW · BETTING CLOSED</span>
        </div>
      </div>
    `;
  }

  if (game.status === "upcoming" && game.startTime) {
    const startMs = new Date(game.startTime).getTime();
    const remaining = startMs - Date.now();
    if (remaining > 0) {
      return `
        <div class="countdown" data-start="${startMs}" data-game-id="${game.id}">
          Bets close in <span class="countdown-time">${formatCountdown(remaining)}</span>
        </div>
      `;
    }
  }
  return '';
}

function showGame(game) {
  document.querySelectorAll(".tab-content").forEach(section => {
    section.classList.remove("active");
  });

  const gameDetails = document.getElementById("gameDetails");
  if (!gameDetails) return;

  gameDetails.classList.remove("hidden");
  gameDetails.classList.add("active");

  const title   = document.getElementById("gameTitle");
  const content = document.getElementById("gameContent");

  if (title) title.textContent = game.name;
  if (!content) return;

  content.innerHTML = "";
  const headerHtml = renderGameHeader(game);

  if (game.status === "upcoming") {
    content.innerHTML = headerHtml + `<h3 style="margin-top:8px">Available Bets</h3>`;
    (game.bets || []).forEach(bet => {
      const label = (typeof bet === 'object' && bet) ? bet.label : bet;
      const div = document.createElement("div");
      div.className = "bet-option";
      div.innerHTML = `<span>${label}</span><span class="bet-arrow">+</span>`;
      div.onclick = () => openBetModal(game, bet);
      content.appendChild(div);
    });
  } else if (game.status === "live") {
    content.innerHTML = headerHtml + `
      <p style="color: var(--muted); margin-top:8px;">
        Game is in progress. Pending bets will be settled when it ends.
      </p>
    `;
  } else {
    content.innerHTML = headerHtml;
  }

  currentDetailGameId = game.id;
}

function goBack() {
  const gameDetails = document.getElementById("gameDetails");
  const schedule    = document.getElementById("schedule");

  if (gameDetails) {
    gameDetails.classList.add("hidden");
    gameDetails.classList.remove("active");
  }

  if (schedule) schedule.classList.add("active");

  document.querySelectorAll(".tab").forEach(btn => btn.classList.remove("active"));
  const firstTab = document.querySelectorAll(".tab")[0];
  if (firstTab) firstTab.classList.add("active");

  currentDetailGameId = null;
}

function loadTeams() {
  const teamGrid = document.getElementById("teamGrid");
  if (!teamGrid) return;

  teamGrid.innerHTML = "";

  teams.forEach(team => {
    const card = document.createElement("div");
    card.className = "team-card";
    card.innerHTML = `
      <div class="team-logo-wrap">
        <img class="team-logo" src="${team.logo}" alt="${team.name} logo" />
      </div>
      <h3>${team.name}</h3>
      <p class="team-stat">Offense: <span>${team.offense}</span></p>
      <p class="team-stat">Defense: <span>${team.defense}</span></p>
    `;
    teamGrid.appendChild(card);
  });
}

async function loadBets() {
  const betsList = document.getElementById("betsList");
  if (!betsList) return;

  try {
    const data = await getBetsData();
    betsList.innerHTML = "";

    if (!data || data.length === 0) {
      betsList.innerHTML = `<p class="empty-msg">No bets placed yet.</p>`;
      return;
    }

    data.forEach(bet => {
      const div = document.createElement("div");
      div.className = "bet-card";

      const isWon       = bet.status === "won";
      const isLost      = bet.status === "lost";
      const isPending   = bet.status === "pending";
      const isCancelled = bet.status === "cancelled";

      const amountText = isCancelled
        ? "—"
        : isWon
          ? `+$${Number(bet.payout).toFixed(2)}`
          : `-$${Number(bet.amount).toFixed(2)}`;

      const cancelBtn = isPending
        ? `<button class="cancel-bet-btn" onclick="cancelBet(${bet.id})">Cancel</button>`
        : "";

      div.innerHTML = `
        <div>
          <span class="game-name">${bet.pick}</span>
          <span class="game-sport">${bet.game} · ${bet.sport}</span>
        </div>
        <div style="text-align:right">
          <span class="status-pill ${bet.status}">${bet.status}</span>
          <span class="tx-amount ${isWon ? "positive" : isLost ? "negative" : ""}">
            ${amountText}
          </span>
          ${cancelBtn}
        </div>
      `;
      betsList.appendChild(div);
    });
  } catch (err) {
    console.error("Failed to load bets:", err);
    betsList.innerHTML = `<p class="empty-msg">Could not load bets.</p>`;
  }
}

async function loadProfile() {
  try {
    const user = await getProfileData();

    const username      = document.getElementById("username");
    const email         = document.getElementById("email");
    const createdAt     = document.getElementById("createdAt");
    const status        = document.getElementById("status");
    const balance       = document.getElementById("balance");
    const avatarInitial = document.getElementById("avatarInitial");
    const headerBalance = document.getElementById("headerBalance");
    const list          = document.getElementById("transactionList");

    if (username)      username.textContent      = user.username ?? "Unknown";
    if (email)         email.textContent         = user.email ?? "";
    if (createdAt)     createdAt.textContent     = user.createdAt ?? "—";
    if (status)        status.textContent        = user.status ?? "";
    if (balance)       balance.textContent       = `$${Number(user.balance || 0).toFixed(2)}`;
    if (avatarInitial) avatarInitial.textContent = (user.username || "?").charAt(0).toUpperCase();
    if (headerBalance) headerBalance.textContent = `Balance: $${Number(user.balance || 0).toFixed(2)}`;

    if (list) {
      list.innerHTML = "";
      (user.transactions || []).forEach(tx => {
        const li = document.createElement("li");
        const isPositive = Number(tx.amount) >= 0;

        li.innerHTML = `
          <span>${tx.type}</span>
          <span class="tx-date">${tx.date || ""}</span>
          <span class="tx-amount ${isPositive ? "positive" : "negative"}">
            ${isPositive ? "+" : ""}$${Math.abs(Number(tx.amount || 0)).toFixed(2)}
          </span>
        `;
        list.appendChild(li);
      });
    }
  } catch (err) {
    console.error("Failed to load profile:", err);
  }
}

// ============================================================================
// LIVE UPDATES
// ----------------------------------------------------------------------------
// We poll /api/games every 10s so status flips and final scores show up
// without a refresh. A separate 1s timer ticks the visible countdowns.
//
// When ANY countdown crosses 00:00 we fire an immediate "eager" poll instead
// of waiting for the next 10s tick - this is what makes the upcoming -> live
// flip and the live -> finished flip feel instant.
// ============================================================================
function startLiveUpdates() {
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      pollGames();
    }, 10000);
  }
  if (!countdownTimer) {
    countdownTimer = setInterval(updateCountdownDisplays, 1000);
  }
}

async function pollGames() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const fresh = await getGamesData();
    const prev = games;
    games = fresh;

    renderSchedule();

    // If we're sitting on a game's detail page and that game changed, re-render.
    if (currentDetailGameId != null) {
      const newer = fresh.find(g => g.id === currentDetailGameId);
      const older = prev.find(g => g.id === currentDetailGameId);
      if (newer && (
        !older ||
        newer.status    !== older.status ||
        newer.homeScore !== older.homeScore ||
        newer.awayScore !== older.awayScore
      )) {
        showGame(newer);
        if (newer.status === 'finished') {
          loadBets();
          loadProfile();
        }
      } else if (!newer) {
        // The game we were viewing got removed (replacement cleanup).
        goBack();
      }
    }
  } catch (err) {
    // Quiet — most likely a transient network blip.
  } finally {
    pollInFlight = false;
  }
}

function updateCountdownDisplays() {
  const elements = document.querySelectorAll('[data-start], [data-end]');
  let shouldEagerPoll = false;

  elements.forEach(el => {
    const targetMs = el.dataset.start
      ? Number(el.dataset.start)
      : Number(el.dataset.end);
    const remaining = targetMs - Date.now();
    const timeEl = el.querySelector('.countdown-time') || el;

    if (remaining <= 0) {
      timeEl.textContent = "00:00";
      // First time crossing zero -> ask the server for fresh state.
      // The server's setTimeout fires at the same wall-clock instant, so
      // by the time the response arrives (~100ms) the flip is already done.
      if (!el.dataset.expired) {
        el.dataset.expired = '1';
        shouldEagerPoll = true;
      }
    } else {
      timeEl.textContent = formatCountdown(remaining);
    }
  });

  if (shouldEagerPoll) {
    pollGames();
  }
}

// ============================================================================
// BET PLACEMENT
// ============================================================================
let activeBet = null;

function calcPayout(amount, odds) {
  if (!amount || amount <= 0) return 0;
  return odds < 0
    ? amount * (1 + 100 / Math.abs(odds))
    : amount * (1 + odds / 100);
}

function openBetModal(game, bet) {
  // bet may be a structured object {label, odds, ...} or a legacy string
  const label = (typeof bet === 'object' && bet) ? bet.label : bet;
  const odds  = (typeof bet === 'object' && bet && Number.isFinite(bet.odds)) ? bet.odds : -110;

  const modal     = document.getElementById("betModal");
  const pickEl    = document.getElementById("modalPick");
  const gameEl    = document.getElementById("modalGame");
  const oddsEl    = document.getElementById("modalOdds");
  const amountEl  = document.getElementById("betAmount");
  const payoutEl  = document.getElementById("modalPayout");
  const errorEl   = document.getElementById("modalError");
  const submitBtn = document.getElementById("modalSubmit");

  activeBet = { gameId: game.id, pick: label, odds };

  if (pickEl)   pickEl.textContent   = label;
  if (gameEl)   gameEl.textContent   = `${game.name} · ${game.sport ?? ""}`;
  if (oddsEl)   oddsEl.textContent   = (odds > 0 ? `+${odds}` : odds);
  if (amountEl) amountEl.value       = "";
  if (payoutEl) payoutEl.textContent = "$0.00";

  if (errorEl) {
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
  }

  if (submitBtn) submitBtn.disabled = false;
  if (modal)     modal.classList.remove("hidden");
}

function closeBetModal() {
  const modal = document.getElementById("betModal");
  if (modal) modal.classList.add("hidden");
  activeBet = null;
}

function updatePayoutPreview() {
  const amountEl = document.getElementById("betAmount");
  const payoutEl = document.getElementById("modalPayout");
  if (!amountEl || !payoutEl) return;

  const amount = Number(amountEl.value);
  const odds   = activeBet?.odds ?? -110;
  const payout = calcPayout(amount, odds);
  payoutEl.textContent = `$${payout.toFixed(2)}`;
}

async function submitBet() {
  if (!activeBet) return;

  const amountEl  = document.getElementById("betAmount");
  const errorEl   = document.getElementById("modalError");
  const submitBtn = document.getElementById("modalSubmit");
  const amount    = Number(amountEl?.value);

  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  }

  if (errorEl) {
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    showError("Enter a wager greater than 0.");
    return;
  }

  if (submitBtn) submitBtn.disabled = true;

  try {
    const response = await fetch(`${API}/api/place-bet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: sessionStorage.getItem("username"),
        gameId: activeBet.gameId,
        pick: activeBet.pick,
        amount
      })
    });

    const data = await response.json();

    if (!response.ok) {
      showError(data.error ?? "Failed to place bet.");
      if (submitBtn) submitBtn.disabled = false;
      return;
    }

    closeBetModal();
    await loadProfile();
    await loadBets();
  } catch (err) {
    console.error("Failed to place bet:", err);
    showError("Network error. Please try again.");
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function cancelBet(betId) {
  if (!betId) return;
  if (!confirm("Cancel this bet and refund your wager?")) return;

  try {
    const response = await fetch(`${API}/api/bets/${betId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: sessionStorage.getItem("username")
      })
    });

    const data = await response.json();

    if (!response.ok) {
      alert(data.error ?? "Failed to cancel bet.");
      return;
    }

    await loadProfile();
    await loadBets();
  } catch (err) {
    console.error("Failed to cancel bet:", err);
    alert("Network error. Please try again.");
  }
}

function logout() {
  sessionStorage.removeItem('loggedIn');
  sessionStorage.removeItem('username');
  window.location.href = 'login.html';
}

window.onload = () => {
  loadGames();
  loadTeams();
  loadProfile();
  loadBets();
  startLiveUpdates();
};
