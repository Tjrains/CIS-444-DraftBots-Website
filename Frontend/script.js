// =============================================
//  DRAFTBOTS — script.js
// =============================================

// --- Sample game data (replace with real API/DB calls later) ---
const games = [
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
  },
  {
    id: 3,
    name: "Bot Echo vs Bot Foxtrot",
    sport: "Boxing",
    status: "upcoming",
    bets: ["Bot Echo -150", "Bot Foxtrot +130"]
  },
  {
    id: 4,
    name: "Bot Golf vs Bot Hotel",
    sport: "Curling",
    status: "upcoming",
    bets: ["Bot Golf -2", "Bot Hotel +2"]
  }
];

// --- Sample team data ---
const teams = [
  { name: "Bot Alpha",   offense: 88, defense: 74 },
  { name: "Bot Bravo",   offense: 65, defense: 91 },
  { name: "Bot Charlie", offense: 79, defense: 80 },
  { name: "Bot Delta",   offense: 83, defense: 68 },
  { name: "Bot Echo",    offense: 92, defense: 55 },
  { name: "Bot Foxtrot", offense: 60, defense: 87 },
  { name: "Bot Golf",    offense: 71, defense: 76 },
  { name: "Bot Hotel",   offense: 77, defense: 82 }
];

// Tracks which tab nav button is active
let activeTabBtn = null;

// -----------------------------------------------
// openTab — switch between main sections
// -----------------------------------------------
function openTab(tabId, btnElement) {
  // Hide all tab sections
  document.querySelectorAll('.tab-content').forEach(section => {
    section.classList.remove('active');
  });

  // Show the selected section
  document.getElementById(tabId).classList.add('active');

  // Make sure game details stays hidden when switching tabs
  document.getElementById('gameDetails').classList.add('hidden');

  // Update the active nav button styling
  document.querySelectorAll('.tab').forEach(btn => btn.classList.remove('active'));
  if (btnElement) btnElement.classList.add('active');
}

// -----------------------------------------------
// loadGames — build game cards in the Schedule tab
// -----------------------------------------------
function loadGames() {
  const gameList = document.getElementById('gameList');
  gameList.innerHTML = '';

  games.forEach(game => {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.onclick = () => showGame(game);

    card.innerHTML = `
      <div class="game-card-left">
        <span class="game-name">${game.name}</span>
        <span class="game-sport">${game.sport}</span>
      </div>
      <span class="status-pill ${game.status}">${game.status}</span>
    `;

    gameList.appendChild(card);
  });
}

// -----------------------------------------------
// showGame — display details/bets for a single game
// -----------------------------------------------
function showGame(game) {
  // Hide all sections, show the game details section
  document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
  document.getElementById('gameDetails').classList.remove('hidden');
  document.getElementById('gameDetails').classList.add('active');

  document.getElementById('gameTitle').textContent = game.name;

  const content = document.getElementById('gameContent');
  content.innerHTML = '';

  if (game.status === "upcoming") {
    content.innerHTML = `<h3>Available Bets</h3>`;
    game.bets.forEach(bet => {
      const div = document.createElement('div');
      div.className = 'bet-option';
      div.innerHTML = `<span>${bet}</span><span class="bet-arrow">+</span>`;
      content.appendChild(div);
    });
  } else {
    content.innerHTML = `
      <h3>🔴 Game is Live!</h3>
      <p style="color: var(--text-muted);">Live gameplay display coming soon.</p>
    `;
  }
}

// -----------------------------------------------
// goBack — return from game details to schedule
// -----------------------------------------------
function goBack() {
  document.getElementById('gameDetails').classList.add('hidden');
  document.getElementById('gameDetails').classList.remove('active');

  // Re-show schedule and reset the nav button
  document.getElementById('schedule').classList.add('active');
  document.querySelectorAll('.tab').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab')[0].classList.add('active'); // first tab = schedule
}

// -----------------------------------------------
// loadTeams — build team cards in the Teams tab
// -----------------------------------------------
function loadTeams() {
  const teamGrid = document.getElementById('teamGrid');
  teamGrid.innerHTML = '';

  teams.forEach(team => {
    const card = document.createElement('div');
    card.className = 'team-card';
    card.innerHTML = `
      <h3>${team.name}</h3>
      <p class="team-stat">Offense: <span>${team.offense}</span></p>
      <p class="team-stat">Defense: <span>${team.defense}</span></p>
    `;
    teamGrid.appendChild(card);
  });
}

// -----------------------------------------------
// loadBets — fetch user bets and fills the Bets tab
// -----------------------------------------------
async function loadBets() {
  const response = await fetch("bets.json");
  const data = await response.json();

  const betsList = document.getElementById("betsList");
  betsList.innerHTML = "";

  if (data.bets.length === 0) {
    betsList.innerHTML = `<p class="empty-msg">No bets placed yet.</p>`;
    return;
  }

  data.bets.forEach(bet => {
    const div = document.createElement("div");
    div.className = "bet-card";
    const isWon = bet.status === "won";
    const isLost = bet.status === "lost";
    div.innerHTML = `
      <div>
        <span class="game-name">${bet.pick}</span>
        <span class="game-sport">${bet.game} · ${bet.sport}</span>
      </div>
      <div style="text-align:right">
        <span class="status-pill ${bet.status}">${bet.status}</span>
        <span class="tx-amount ${isWon ? 'positive' : isLost ? 'negative' : ''}">
          ${isWon ? '+$' + bet.payout.toFixed(2) : '-$' + bet.amount.toFixed(2)}
        </span>
      </div>
    `;
    betsList.appendChild(div);
  });
}

// -----------------------------------------------
// loadProfile — fetch user data and fill Profile tab
// -----------------------------------------------
async function loadProfile() {
  try {
    const response = await fetch("users.json");
    const user = await response.json();

    // Fill in profile fields
    document.getElementById("username").textContent = user.username;
    document.getElementById("email").textContent = user.email;
    document.getElementById("createdAt").textContent = user.createdAt;
    document.getElementById("status").textContent = user.status;
    document.getElementById("balance").textContent = "$" + user.balance.toFixed(2);

    // Set avatar to first letter of username
    document.getElementById("avatarInitial").textContent = user.username.charAt(0).toUpperCase();

    // Update header balance
    document.getElementById("headerBalance").textContent = "Balance: $" + user.balance.toFixed(2);

    // Build transaction list
    const list = document.getElementById("transactionList");
    list.innerHTML = "";
    user.transactions.forEach(tx => {
      const li = document.createElement("li");
      const isPositive = tx.amount >= 0;
      li.innerHTML = `
        <span>${tx.type}</span>
        <span class="tx-date">${tx.date}</span>
        <span class="tx-amount ${isPositive ? 'positive' : 'negative'}">
          ${isPositive ? '+' : ''}$${Math.abs(tx.amount).toFixed(2)}
        </span>
      `;
      list.appendChild(li);
    });

  } catch (err) {
    console.error("Failed to load user profile:", err);
  }
}

// -----------------------------------------------
// Init — run on page load
// -----------------------------------------------
window.onload = () => {
  loadGames();
  loadTeams();
  loadProfile();
  loadBets();
};
