const games = [
  {
    id: 1,
    name: "Lakers vs Warriors",
    status: "upcoming",
    bets: ["Lakers +5", "Warriors -5", "Over 210", "Under 210"]
  },
  {
    id: 2,
    name: "Dolphins vs Bills",
    status: "live",
    bets: []
  }
];

function openTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  document.getElementById('gameDetails').classList.add('hidden');
}

function loadGames() {
  const gameList = document.getElementById('gameList');
  gameList.innerHTML = '';

  games.forEach(game => {
    const li = document.createElement('li');
    li.textContent = game.name + " (" + game.status + ")";
    li.onclick = () => showGame(game);
    gameList.appendChild(li);
  });
}

function showGame(game) {
  document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
  document.getElementById('gameDetails').classList.remove('hidden');

  document.getElementById('gameTitle').textContent = game.name;

  const content = document.getElementById('gameContent');
  content.innerHTML = '';

  if (game.status === "upcoming") {
    content.innerHTML = "<h3>Available Bets</h3>";
    game.bets.forEach(bet => {
      const p = document.createElement('p');
      p.textContent = bet;
      content.appendChild(p);
    });
  } else {
    content.innerHTML = "<h3>Game is Live!</h3><p>Live gameplay display coming soon.</p>";
  }
}

function goBack() {
  document.getElementById('gameDetails').classList.add('hidden');
  openTab('schedule');
}

window.onload = loadGames;