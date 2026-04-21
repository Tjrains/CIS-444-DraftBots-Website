const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'draftbots.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`DROP TABLE IF EXISTS transactions`);
  db.run(`DROP TABLE IF EXISTS bets`);
  db.run(`DROP TABLE IF EXISTS games`);
  db.run(`DROP TABLE IF EXISTS users`);

  db.run(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      balance REAL NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      game TEXT NOT NULL,
      sport TEXT NOT NULL,
      pick TEXT NOT NULL,
      amount REAL NOT NULL,
      odds INTEGER NOT NULL,
      payout REAL NOT NULL,
      status TEXT NOT NULL,
      date TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE games (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      sport TEXT NOT NULL,
      status TEXT NOT NULL,
      bets TEXT NOT NULL
    )
  `);

  db.run(
    `INSERT INTO users (id, username, email, created_at, status, balance)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [1, 'tyler', 'tyler@example.com', '2026-04-01', 'Active', 125.5]
  );

  const transactions = [
    ['Deposit', 100, '2026-04-01'],
    ['Bet - Lakers +5', -15, '2026-04-05'],
    ['Win', 40, '2026-04-05']
  ];

  const txStmt = db.prepare(
    `INSERT INTO transactions (user_id, type, amount, date) VALUES (?, ?, ?, ?)`
  );
  transactions.forEach(tx => txStmt.run(1, tx[0], tx[1], tx[2]));
  txStmt.finalize();

  const bets = [
    ['Bot Alpha vs Bot Bravo', 'Football', 'Bot Alpha -3.5', 20, -110, 38.18, 'won', '2026-04-10'],
    ['Bot Echo vs Bot Foxtrot', 'Boxing', 'Bot Foxtrot +130', 15, 130, 34.50, 'lost', '2026-04-11'],
    ['Bot Golf vs Bot Hotel', 'Curling', 'Bot Golf -2', 25, -115, 46.74, 'pending', '2026-04-14'],
    ['Bot Charlie vs Bot Delta', 'Soccer', 'Over 2.5 Goals', 10, -105, 19.52, 'live', '2026-04-14']
  ];

  const betStmt = db.prepare(`
    INSERT INTO bets (user_id, game, sport, pick, amount, odds, payout, status, date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  bets.forEach(bet => betStmt.run(1, ...bet));
  betStmt.finalize();

  const games = [
    [1, 'Bot Alpha vs Bot Bravo', 'Football', 'upcoming', JSON.stringify(['Bot Alpha -3.5', 'Bot Bravo +3.5', 'Over 42.5', 'Under 42.5'])],
    [2, 'Bot Charlie vs Bot Delta', 'Soccer', 'live', JSON.stringify([])],
    [3, 'Bot Echo vs Bot Foxtrot', 'Boxing', 'upcoming', JSON.stringify(['Bot Echo -150', 'Bot Foxtrot +130'])],
    [4, 'Bot Golf vs Bot Hotel', 'Curling', 'upcoming', JSON.stringify(['Bot Golf -2', 'Bot Hotel +2'])]
  ];

  const gameStmt = db.prepare(
    `INSERT INTO games (id, name, sport, status, bets) VALUES (?, ?, ?, ?, ?)`
  );
  games.forEach(game => gameStmt.run(...game));
  gameStmt.finalize();
});

db.close(() => {
  console.log('Database initialized at backend/draftbots.db');
});