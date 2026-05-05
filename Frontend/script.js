// AUTH GUARD — redirect to login if not logged in
// This runs immediately when the script loads
(function checkAuth() {
  if (!sessionStorage.getItem('loggedIn')) {
    window.location.href = 'login.html';
  }
})();

let games = [];

// --- Sample team data ---
const teams = [
  { name: "Austin Armadillos", city: "Austin", logo: "Austin.webp", offense: 88, defense: 74 },
  { name: "Portland Stormchasers", city: "Portland", logo: "Portland.webp", offense: 65, defense: 91 },
  { name: "Nashville High Notes", city: "Nashville", logo: "Nashville.webp", offense: 79, defense: 80 },
  { name: "New York Empire", city: "New York", logo: "New_York.webp", offense: 83, defense: 68 },
  { name: "El Paso Desert Wolves", city: "El Paso", logo: "El_Paso.webp", offense: 92, defense: 55 },
  { name: "Boise Potato Kings", city: "Boise", logo: "Boise.webp", offense: 60, defense: 87 },
  { name: "Minneapolis Northstars", city: "Minneapolis", logo: "Minneapolis.webp", offense: 71, defense: 76 },
  { name: "San Diego Sun Rays", city: "San Diego", logo: "San_Diego.webp", offense: 77, defense: 82 }
];

const API =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.protocol === "file:"
    ? "http://localhost:3000"
    : "https://draftbots.onrender.com";

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

async function loadGames() {
  const gameList = document.getElementById("gameList");
  if (!gameList) return;

  gameList.innerHTML = "";

  try {
    games = await getGamesData();

    games.forEach(game => {
      const card = document.createElement("div");
      card.className = "game-card";
      card.onclick = () => showGame(game);

      card.innerHTML = `
        <div class="game-card-left">
          <span class="game-name">${game.name}</span>
          <span class="game-sport">${game.sport || ""}</span>
        </div>
        <span class="status-pill ${game.status}">${game.status}</span>
      `;

      gameList.appendChild(card);
    });
  } catch (err) {
    console.error("Failed to load games:", err);
    gameList.innerHTML = `<p class="empty-msg">Could not load games.</p>`;
  }
}

function showGame(game) {
  document.querySelectorAll(".tab-content").forEach(section => {
    section.classList.remove("active");
  });

  const gameDetails = document.getElementById("gameDetails");
  if (!gameDetails) return;

  gameDetails.classList.remove("hidden");
  gameDetails.classList.add("active");

  const title = document.getElementById("gameTitle");
  const content = document.getElementById("gameContent");

  if (title) title.textContent = game.name;
  if (!content) return;

  content.innerHTML = "";

  if (game.status === "upcoming") {
    content.innerHTML = `<h3>Available Bets</h3>`;
    game.bets.forEach(bet => {
      const div = document.createElement("div");
      div.className = "bet-option";
      div.innerHTML = `<span>${bet}</span><span class="bet-arrow">+</span>`;
      div.onclick = () => openBetModal(game, bet);
      content.appendChild(div);
    });
  } else {
    content.innerHTML = `
      <h3>🔴 Game is Live!</h3>
      <p style="color: var(--muted);">Live gameplay display coming soon.</p>
    `;
  }
}

function goBack() {
  const gameDetails = document.getElementById("gameDetails");
  const schedule = document.getElementById("schedule");

  if (gameDetails) {
    gameDetails.classList.add("hidden");
    gameDetails.classList.remove("active");
  }

  if (schedule) schedule.classList.add("active");

  document.querySelectorAll(".tab").forEach(btn => btn.classList.remove("active"));
  const firstTab = document.querySelectorAll(".tab")[0];
  if (firstTab) firstTab.classList.add("active");
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

      const isWon = bet.status === "won";
      const isLost = bet.status === "lost";
      const amountText = isWon
        ? `+$${Number(bet.payout).toFixed(2)}`
        : `-$${Number(bet.amount).toFixed(2)}`;

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

    const username = document.getElementById("username");
    const email = document.getElementById("email");
    const createdAt = document.getElementById("createdAt");
    const status = document.getElementById("status");
    const balance = document.getElementById("balance");
    const avatarInitial = document.getElementById("avatarInitial");
    const headerBalance = document.getElementById("headerBalance");
    const list = document.getElementById("transactionList");

    if (username) username.textContent = user.username ?? "Unknown";
    if (email) email.textContent = user.email ?? "";
    if (createdAt) createdAt.textContent = user.createdAt ?? "—";
    if (status) status.textContent = user.status ?? "";
    if (balance) balance.textContent = `$${Number(user.balance || 0).toFixed(2)}`;
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


// BET PLACEMENT
const BET_ODDS = -110;
let activeBet = null;

function calcPayout(amount, odds) {
  if (!amount || amount <= 0) return 0;
  return odds < 0
    ? amount * (1 + 100 / Math.abs(odds))
    : amount * (1 + odds / 100);
}

function openBetModal(game, pick) {
  const modal = document.getElementById("betModal");
  const pickEl = document.getElementById("modalPick");
  const gameEl = document.getElementById("modalGame");
  const oddsEl = document.getElementById("modalOdds");
  const amountEl = document.getElementById("betAmount");
  const payoutEl = document.getElementById("modalPayout");
  const errorEl = document.getElementById("modalError");
  const submitBtn = document.getElementById("modalSubmit");

  activeBet = { gameId: game.id, pick };

  if (pickEl) pickEl.textContent = pick;
  if (gameEl) gameEl.textContent = `${game.name} · ${game.sport ?? ""}`;
  if (oddsEl) oddsEl.textContent = BET_ODDS;
  if (amountEl) amountEl.value = "";
  if (payoutEl) payoutEl.textContent = "$0.00";

  if (errorEl) {
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
  }

  if (submitBtn) submitBtn.disabled = false;
  if (modal) modal.classList.remove("hidden");
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
  const payout = calcPayout(amount, BET_ODDS);
  payoutEl.textContent = `$${payout.toFixed(2)}`;
}

async function submitBet() {
  if (!activeBet) return;

  const amountEl = document.getElementById("betAmount");
  const errorEl = document.getElementById("modalError");
  const submitBtn = document.getElementById("modalSubmit");
  const amount = Number(amountEl?.value);

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

//ADDING LOGOUT FUNCITON
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
};