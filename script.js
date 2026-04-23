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
  { name: "Bot Alpha", offense: 88, defense: 74 },
  { name: "Bot Bravo", offense: 65, defense: 91 },
  { name: "Bot Charlie", offense: 79, defense: 80 },
  { name: "Bot Delta", offense: 83, defense: 68 },
  { name: "Bot Echo", offense: 92, defense: 55 },
  { name: "Bot Foxtrot", offense: 60, defense: 87 },
  { name: "Bot Golf", offense: 71, defense: 76 },
  { name: "Bot Hotel", offense: 77, defense: 82 }
];

const isLocal =
  window.location.hostname === "localhost" &&
  window.location.port === "8000";

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
  const response = isLocal
    ? await fetch("http://localhost:3000/api/profile")
    : await fetch("users.json");

  if (!response.ok) throw new Error("Failed to load profile");
  return await response.json();
}

async function getBetsData() {
  if (isLocal) {
    const response = await fetch("http://localhost:3000/api/bets");
    if (!response.ok) throw new Error("Failed to load bets");
    return await response.json();
  } else {
    const response = await fetch("bets.json");
    if (!response.ok) throw new Error("Failed to load bets.json");
    const data = await response.json();
    return data.bets || [];
  }
}

async function getGamesData() {
  if (isLocal) {
    const response = await fetch("http://localhost:3000/api/games");
    if (!response.ok) throw new Error("Failed to load games");
    return await response.json();
  } else {
    return [
      {
        id: 1,
        name: "Bot Alpha vs Bot Bravo",
        sport: "Football",
        status: "upcoming",
        bets: ["Bot Alpha -3.5", "Bot Bravo +3.5", "Over 42.5", "Under 42.5"]
      },
      {
        id: 2,
        name: "Bot Charlie vs Bot Delta",
        sport: "Soccer",
        status: "live",
        bets: []
      }
    ];
  }
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