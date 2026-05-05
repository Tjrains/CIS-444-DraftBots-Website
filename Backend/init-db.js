const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
function hashPassword(p) { return crypto.createHash('sha1').update(p).digest('hex'); }

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
      balance REAL NOT NULL,
      password TEXT NOT NULL
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

  // games table tracks the lifecycle (start/end times) and the final score
  db.run(`
    CREATE TABLE games (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      sport TEXT NOT NULL,
      status TEXT NOT NULL,
      bets TEXT NOT NULL,
      start_time TEXT,
      end_time   TEXT,
      home_score INTEGER,
      away_score INTEGER
    )
  `);

  db.run(
    `INSERT INTO users (id, username, email, created_at, status, balance, password)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [1, 'tyler', 'tyler@example.com', '2026-04-01', 'Active', 125, hashPassword('password123')]
  );

  const transactions = [
    ['Deposit', 100, '2026-04-01'],
    ['Bet', -15, '2026-04-05'],
    ['Win', 40, '2026-04-05']
  ];

  const txStmt = db.prepare(
    `INSERT INTO transactions (user_id, type, amount, date) VALUES (?, ?, ?, ?)`
  );
  transactions.forEach(tx => txStmt.run(1, tx[0], tx[1], tx[2]));
  txStmt.finalize();

  // Tyler's seeded bets. Picks reference the games below by exact label.
  const bets = [
    ['Austin Armadillos vs Portland Stormchasers',   'Football', 'Austin Armadillos -3.5',     20, -110, 40.00, 'won',     '2026-04-10'],
    ['El Paso Desert Wolves vs Boise Potato Kings',  'Boxing',   'Boise Potato Kings +130',    15,  130, 15.00, 'lost',    '2026-04-11'],
    ['Minneapolis Northstars vs San Diego Sun Rays', 'Curling',  'Minneapolis Northstars -2',  25, -115, 46.74, 'pending', '2026-04-14'],
    ['Nashville High Notes vs New York Empire',      'Soccer',   'Over 2.5 Goals',             10, -105, 19.52, 'live',    '2026-04-14']
  ];

  const betStmt = db.prepare(`
    INSERT INTO bets (user_id, game, sport, pick, amount, odds, payout, status, date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  bets.forEach(bet => betStmt.run(1, ...bet));
  betStmt.finalize();

  // Bets are now structured objects so the lifecycle code can resolve them
  // automatically against the generated final score:
  //   label     - what the user sees and what gets stored as "pick"
  //   type      - 'spread' | 'total' | 'moneyline'
  //   side      - 'home' | 'away'  (first team in name = home)
  //   direction - 'over' | 'under' (for totals)
  //   line      - the spread or total line
  //   odds      - American odds for this bet
  //
  // Game ORDER below is significant. On boot, the lifecycle assigns games
  // by id to demo slots:
  //   id=1 -> stays finished  (already has a score from this seed)
  //   id=2 -> live, 30 min remaining
  //   id=3 -> 5-minute demo upcoming  (Tyler's pending Curling bet resolves here!)
  //   id=4 -> regular upcoming, starts in 1 hour, lasts 1 hour
  const games = [
    [1, 'Austin Armadillos vs Portland Stormchasers', 'Football', 'finished',
      JSON.stringify([
        { label: 'Austin Armadillos -3.5',     type: 'spread', side: 'home', line: -3.5, odds: -110 },
        { label: 'Portland Stormchasers +3.5', type: 'spread', side: 'away', line:  3.5, odds: -110 },
        { label: 'Over 42.5',                  type: 'total',  direction: 'over',  line: 42.5, odds: -110 },
        { label: 'Under 42.5',                 type: 'total',  direction: 'under', line: 42.5, odds: -110 }
      ]),
      24, 17  // home_score, away_score (Austin won 24-17, covered the -3.5 spread)
    ],
    [2, 'Nashville High Notes vs New York Empire', 'Soccer', 'upcoming',
      JSON.stringify([
        { label: 'Over 2.5 Goals',  type: 'total', direction: 'over',  line: 2.5, odds: -110 },
        { label: 'Under 2.5 Goals', type: 'total', direction: 'under', line: 2.5, odds: -105 }
      ]),
      null, null
    ],
    [3, 'Minneapolis Northstars vs San Diego Sun Rays', 'Curling', 'upcoming',
      JSON.stringify([
        { label: 'Minneapolis Northstars -2', type: 'spread', side: 'home', line: -2, odds: -115 },
        { label: 'San Diego Sun Rays +2',     type: 'spread', side: 'away', line:  2, odds: -115 }
      ]),
      null, null
    ],
    [4, 'El Paso Desert Wolves vs Boise Potato Kings', 'Boxing', 'upcoming',
      JSON.stringify([
        { label: 'El Paso Desert Wolves -150', type: 'moneyline', side: 'home', odds: -150 },
        { label: 'Boise Potato Kings +130',    type: 'moneyline', side: 'away', odds:  130 }
      ]),
      null, null
    ]
  ];

  const gameStmt = db.prepare(
    `INSERT INTO games (id, name, sport, status, bets, home_score, away_score)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  games.forEach(game => gameStmt.run(...game));
  gameStmt.finalize();
});

db.close(() => {
  console.log('Database initialized at backend/draftbots.db');
});
