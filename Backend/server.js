const express = require('express');
const cors    = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path    = require('path');
const crypto  = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Using SHA-1 for encryption
function hashPassword(plainText) {
  return crypto.createHash('sha1').update(plainText).digest('hex');
}

const dbPath = path.join(__dirname, 'draftbots.db');
const db = new sqlite3.Database(dbPath);

// ============================================================================
// Promise wrappers for sqlite3.
// The lifecycle code below has nested DB calls (load game -> load bets ->
// update each bet -> credit user -> insert transaction). Doing that with raw
// callbacks turns into a pyramid; promises let us write it as a clean
// sequential async function.
// ============================================================================
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
});

// ============================================================================
// GAME LIFECYCLE
// ----------------------------------------------------------------------------
// On boot, schedule one game to go live in 5 min and finish 5 min after that.
// When it finishes, we generate a sport-appropriate score, resolve every
// pending bet on that game, then loop into the next game after a short gap.
// ============================================================================

const START_DELAY_MS   = 5 * 60 * 1000;  // boot -> game starts (bets close)
const GAME_DURATION_MS = 5 * 60 * 1000;  // game runs for this long
const GAP_BETWEEN_MS   = 60 * 1000;      // gap between cycles

// Realistic-ish score ranges per sport. Adjust to taste.
const SCORE_RANGES = {
  Football: { home: [10, 38], away: [10, 38] },
  Soccer:   { home: [0, 4],   away: [0, 4]   },
  Boxing:   { home: [0, 12],  away: [0, 12]  },
  Curling:  { home: [3, 10],  away: [3, 10]  }
};

function randInt(lo, hi) {
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function generateScore(sport) {
  const range = SCORE_RANGES[sport] || { home: [0, 50], away: [0, 50] };
  return {
    home: randInt(range.home[0], range.home[1]),
    away: randInt(range.away[0], range.away[1])
  };
}

// Hybrid resolution: spreads & totals are decided by the score; moneyline
// (and anything we can't structurally identify) falls back to a 50/50 coin
// flip per the design choice.
function determineOutcome(pickLabel, gameBetDefs, homeScore, awayScore) {
  const def = (gameBetDefs || []).find(b => b && b.label === pickLabel);
  if (!def) {
    // Old/unstructured bet definition - we can't parse it, so coin-flip it.
    return Math.random() < 0.5 ? 'won' : 'lost';
  }

  if (def.type === 'total') {
    const total = homeScore + awayScore;
    if (def.direction === 'over')  return total >  def.line ? 'won' : 'lost';
    if (def.direction === 'under') return total <  def.line ? 'won' : 'lost';
    return Math.random() < 0.5 ? 'won' : 'lost';
  }

  if (def.type === 'spread') {
    // "home -3.5" wins if (home - away) > 3.5 -> margin + line > 0
    // "away +3.5" wins if (away - home) > -3.5 -> margin + line > 0
    const margin = def.side === 'home'
      ? (homeScore - awayScore)
      : (awayScore - homeScore);
    return (margin + def.line) > 0 ? 'won' : 'lost';
  }

  // moneyline / props / unknown -> random per design
  return Math.random() < 0.5 ? 'won' : 'lost';
}

// Pick the next game to put through the lifecycle. We prefer one that's
// already 'upcoming' (so on a fresh boot the existing Curling game runs
// first), and otherwise recycle a finished game.
async function pickNextGame() {
  let game = await dbGet(
    `SELECT * FROM games WHERE status = 'upcoming' ORDER BY id ASC LIMIT 1`
  );
  if (game) return game;

  game = await dbGet(
    `SELECT * FROM games WHERE status = 'finished' ORDER BY id ASC LIMIT 1`
  );
  return game;
}

async function startNextGame() {
  try {
    const game = await pickNextGame();
    if (!game) {
      console.log('[lifecycle] No games available to run.');
      return;
    }

    const now = Date.now();
    const startTime = new Date(now + START_DELAY_MS).toISOString();
    const endTime   = new Date(now + START_DELAY_MS + GAME_DURATION_MS).toISOString();

    await dbRun(
      `UPDATE games
          SET status = 'upcoming',
              start_time = ?,
              end_time   = ?,
              home_score = NULL,
              away_score = NULL
        WHERE id = ?`,
      [startTime, endTime, game.id]
    );

    console.log(`[lifecycle] ${game.name} -> upcoming. Locks ${startTime}, ends ${endTime}.`);

    setTimeout(() => goLive(game.id).catch(console.error), START_DELAY_MS);
    setTimeout(() => endGame(game.id).catch(console.error), START_DELAY_MS + GAME_DURATION_MS);
  } catch (err) {
    console.error('[lifecycle] startNextGame failed:', err);
  }
}

async function goLive(gameId) {
  await dbRun(`UPDATE games SET status = 'live' WHERE id = ?`, [gameId]);
  const g = await dbGet(`SELECT name FROM games WHERE id = ?`, [gameId]);
  console.log(`[lifecycle] ${g ? g.name : gameId} is LIVE. Bets are closed.`);
}

async function endGame(gameId) {
  const game = await dbGet(`SELECT * FROM games WHERE id = ?`, [gameId]);
  if (!game) return;

  const score = generateScore(game.sport);

  await dbRun(
    `UPDATE games
        SET status = 'finished',
            home_score = ?,
            away_score = ?
      WHERE id = ?`,
    [score.home, score.away, gameId]
  );

  console.log(`[lifecycle] ${game.name} FINISHED  ${score.home} - ${score.away}.`);

  // Resolve every bet on this game that's still open.
  let betDefs = [];
  try { betDefs = JSON.parse(game.bets || '[]'); } catch (_) { /* ignore */ }

  const pendingBets = await dbAll(
    `SELECT * FROM bets WHERE game = ? AND status IN ('pending', 'live')`,
    [game.name]
  );

  for (const bet of pendingBets) {
    const outcome = determineOutcome(bet.pick, betDefs, score.home, score.away);
    await dbRun(`UPDATE bets SET status = ? WHERE id = ?`, [outcome, bet.id]);

    if (outcome === 'won') {
      const today = new Date().toISOString().split('T')[0];
      await dbRun(
        `UPDATE users SET balance = balance + ? WHERE id = ?`,
        [bet.payout, bet.user_id]
      );
      await dbRun(
        `INSERT INTO transactions (user_id, type, amount, date) VALUES (?, 'Win', ?, ?)`,
        [bet.user_id, bet.payout, today]
      );
      console.log(`[lifecycle]   bet #${bet.id} (user ${bet.user_id}, ${bet.pick}) WON  +$${bet.payout}`);
    } else {
      console.log(`[lifecycle]   bet #${bet.id} (user ${bet.user_id}, ${bet.pick}) LOST -$${bet.amount}`);
    }
  }

  // Loop into the next cycle after a short gap.
  setTimeout(() => startNextGame().catch(console.error), GAP_BETWEEN_MS);
}

// Make sure the new columns exist even if someone hasn't re-run init-db
// (Render's persistent disk keeps the old DB file around between deploys).
async function ensureSchema() {
  const cols = await dbAll(`PRAGMA table_info(games)`);
  const have = new Set(cols.map(c => c.name));
  const adds = [];
  if (!have.has('start_time')) adds.push(`ALTER TABLE games ADD COLUMN start_time TEXT`);
  if (!have.has('end_time'))   adds.push(`ALTER TABLE games ADD COLUMN end_time   TEXT`);
  if (!have.has('home_score')) adds.push(`ALTER TABLE games ADD COLUMN home_score INTEGER`);
  if (!have.has('away_score')) adds.push(`ALTER TABLE games ADD COLUMN away_score INTEGER`);
  for (const sql of adds) await dbRun(sql);
  if (adds.length) console.log(`[lifecycle] migrated ${adds.length} new game columns.`);
}

async function bootLifecycle() {
  try {
    await ensureSchema();

    // Any game still marked 'live' is orphaned from a previous server run -
    // there's no setTimeout pointing at it anymore. Mark it finished so it
    // doesn't show as live forever in the UI.
    await dbRun(`UPDATE games SET status = 'finished' WHERE status = 'live'`);

    await startNextGame();
  } catch (err) {
    console.error('[lifecycle] boot failed:', err);
  }
}

// ============================================================================
// ROUTES
// ============================================================================

app.get('/', (req, res) => {
  res.send('DraftBots backend is running.');
});

// PROFILE
app.get('/api/profile', (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ error: 'Username is required.' });
  }

  db.get(
    `SELECT id, username, email, created_at, status, balance
       FROM users
      WHERE username = ?`,
    [username],
    (err, user) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to load user' });
      }
      if (!user) return res.status(404).json({ error: 'User not found' });

      db.all(
        `SELECT type, amount, date
           FROM transactions
          WHERE user_id = ?
          ORDER BY id DESC`,
        [user.id],
        (err, transactions) => {
          if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to load transactions' });
          }

          res.json({
            username: user.username,
            email: user.email,
            createdAt: user.created_at,
            status: user.status,
            balance: user.balance,
            transactions
          });
        }
      );
    }
  );
});

// BETS
app.get('/api/bets', (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ error: 'Username is required.' });
  }

  db.all(
    `SELECT b.id, b.game, b.sport, b.pick, b.amount, b.odds, b.payout, b.status, b.date
       FROM bets b
       JOIN users u ON b.user_id = u.id
      WHERE u.username = ?
      ORDER BY b.id DESC`,
    [username],
    (err, bets) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to load bets' });
      }
      res.json(bets);
    }
  );
});

// GAMES — now returns lifecycle timestamps and final scores
app.get('/api/games', (req, res) => {
  db.all(
    `SELECT id, name, sport, status, bets, start_time, end_time, home_score, away_score
       FROM games
      ORDER BY id ASC`,
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to load games' });
      }

      const games = rows.map(row => {
        let bets = [];
        try { bets = JSON.parse(row.bets || '[]'); } catch (_) { bets = []; }
        return {
          id: row.id,
          name: row.name,
          sport: row.sport,
          status: row.status,
          bets,
          startTime: row.start_time,
          endTime:   row.end_time,
          homeScore: row.home_score,
          awayScore: row.away_score
        };
      });

      res.json(games);
    }
  );
});

// REGISTER
app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const hashed = hashPassword(password);
  const today  = new Date().toISOString().split('T')[0];

  db.run(
    `INSERT INTO users (username, email, created_at, status, balance, password)
     VALUES (?, ?, ?, 'Active', 100.00, ?)`,
    [username, email, today, hashed],
    function (err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(409).json({ error: 'Username already taken.' });
        }
        console.error(err);
        return res.status(500).json({ error: 'Registration failed.' });
      }
      res.status(201).json({ message: 'Account created successfully.' });
    }
  );
});

// LOGIN
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const hashed = hashPassword(password);

  db.get(
    `SELECT id, username, email, status, balance
       FROM users
      WHERE username = ? AND password = ?`,
    [username, hashed],
    (err, user) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Login failed.' });
      }
      if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

      res.json({
        username: user.username,
        email:    user.email,
        status:   user.status,
        balance:  user.balance
      });
    }
  );
});

// PLACE BET — pulls odds from the structured bet definition and rejects
// bets that arrive after the game's start_time.
app.post('/api/place-bet', (req, res) => {
  const { username, gameId, pick, amount } = req.body;

  if (!username || !gameId || !pick || amount === undefined) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const wager = Number(amount);
  if (!Number.isFinite(wager) || wager <= 0) {
    return res.status(400).json({ error: 'Wager must be greater than 0.' });
  }

  const today = new Date().toISOString().split('T')[0];

  db.get(
    `SELECT id, balance FROM users WHERE username = ?`,
    [username],
    (err, user) => {
      if (err) { console.error(err); return res.status(500).json({ error: 'Failed to load user.' }); }
      if (!user) return res.status(404).json({ error: 'User not found.' });
      if (user.balance < wager) return res.status(400).json({ error: 'Insufficient balance.' });

      db.get(
        `SELECT id, name, sport, status, bets, start_time
           FROM games
          WHERE id = ?`,
        [gameId],
        (err, game) => {
          if (err) { console.error(err); return res.status(500).json({ error: 'Failed to load game.' }); }
          if (!game) return res.status(404).json({ error: 'Game not found.' });

          if (game.status !== 'upcoming') {
            return res.status(400).json({ error: 'Bets are only allowed on upcoming games.' });
          }
          // Defensive: even if the status flip hasn't fired yet, refuse bets
          // placed at/after the scheduled lock time.
          if (game.start_time && Date.now() >= new Date(game.start_time).getTime()) {
            return res.status(400).json({ error: 'Betting has closed for this game.' });
          }

          let validPicks = [];
          try {
            validPicks = JSON.parse(game.bets || '[]');
          } catch (parseErr) {
            console.error(parseErr);
            return res.status(500).json({ error: 'Game bet options are invalid.' });
          }

          // Find the structured bet so we know the real odds.
          // Fallback to -110 for legacy string-only definitions.
          let betDef = null;
          if (validPicks.length && typeof validPicks[0] === 'object') {
            betDef = validPicks.find(b => b.label === pick);
            if (!betDef) return res.status(400).json({ error: 'Invalid pick for this game.' });
          } else {
            // legacy data path
            if (!validPicks.includes(pick)) {
              return res.status(400).json({ error: 'Invalid pick for this game.' });
            }
            betDef = { odds: -110 };
          }

          const odds = betDef.odds;
          const payout = +(odds < 0
            ? wager * (1 + 100 / Math.abs(odds))
            : wager * (1 + odds / 100)
          ).toFixed(2);

          db.serialize(() => {
            db.run('BEGIN TRANSACTION');

            db.run(
              `UPDATE users SET balance = balance - ? WHERE id = ?`,
              [wager, user.id]
            );

            db.run(
              `INSERT INTO bets (user_id, game, sport, pick, amount, odds, payout, status, date)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
              [user.id, game.name, game.sport, pick, wager, odds, payout, today]
            );

            db.run(
              `INSERT INTO transactions (user_id, type, amount, date)
               VALUES (?, ?, ?, ?)`,
              [user.id, `Bet - ${pick}`, -wager, today]
            );

            db.run('COMMIT', (err) => {
              if (err) {
                console.error(err);
                return res.status(500).json({ error: 'Failed to place bet.' });
              }

              res.status(201).json({
                pick,
                amount: wager,
                odds,
                payout,
                status: 'pending',
                newBalance: +(user.balance - wager).toFixed(2)
              });
            });
          });
        }
      );
    }
  );
});

// DEBUG
app.get('/api/debug/all', (req, res) => {
  db.all('SELECT * FROM users', [], (err, users) => {
    if (err) return res.status(500).json(err);
    db.all('SELECT * FROM bets', [], (err2, bets) => {
      if (err2) return res.status(500).json(err2);
      db.all('SELECT * FROM games', [], (err3, games) => {
        if (err3) return res.status(500).json(err3);
        res.json({ users, bets, games });
      });
    });
  });
});

app.listen(PORT, () => {
  console.log(`DraftBots backend running on http://localhost:${PORT}`);
  // Kick off the game lifecycle as soon as the server is up.
  bootLifecycle();
});
