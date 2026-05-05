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
// The lifecycle has nested DB calls (load game -> load bets -> update each
// bet -> credit user -> insert transaction). Doing that with raw callbacks
// turns into a pyramid; promises let us write clean sequential async funcs.
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
// On boot we set up a fresh demo state with all 4 games concurrently:
//   slot 1: finished (id=1, with a real score from the seed)
//   slot 2: live, 30 min remaining (id=2)
//   slot 3: 5-min demo - starts in 5 min, ends in 10 min (id=3)
//   slot 4: regular - starts in 1 hr, ends in 2 hr (id=4)
//
// When a game finishes:
//   * its bets are resolved against the generated score
//   * if there are now 2+ finished games, the OLDEST is deleted and a
//     replacement upcoming game is created with the same teams in a
//     different sport (regular 1-hour cycle)
//
// This guarantees: at most 1 finished game and at least 2 bettable games
// visible at any time.
// ============================================================================

const FIVE_MIN   = 5  * 60 * 1000;
const THIRTY_MIN = 30 * 60 * 1000;
const ONE_HOUR   = 60 * 60 * 1000;
const TWO_HOURS  = 2  * ONE_HOUR;

// Demo slot timing. Kept tight so the user can see the bet-and-payout
// flow within ~6 min of server boot.
const DEMO_START_DELAY_MS = 5 * 60 * 1000; // game starts 5 min after boot
const DEMO_DURATION_MS    = 60 * 1000;     // game lasts 1 min
const DEMO_END_DELAY_MS   = DEMO_START_DELAY_MS + DEMO_DURATION_MS;

// Realistic-ish score ranges per sport. Adjust to taste.
const SCORE_RANGES = {
  Football:   { home: [10, 38], away: [10, 38] },
  Basketball: { home: [88, 122], away: [88, 122] },
  Hockey:     { home: [0, 6],   away: [0, 6]   },
  Baseball:   { home: [0, 9],   away: [0, 9]   },
  Soccer:     { home: [0, 4],   away: [0, 4]   },
  Boxing:     { home: [0, 12],  away: [0, 12]  },
  Curling:    { home: [3, 10],  away: [3, 10]  }
};

const ALL_SPORTS = Object.keys(SCORE_RANGES);

function randInt(lo, hi) { return Math.floor(Math.random() * (hi - lo + 1)) + lo; }
function randPick(arr)   { return arr[Math.floor(Math.random() * arr.length)]; }

function generateScore(sport) {
  const range = SCORE_RANGES[sport] || { home: [0, 50], away: [0, 50] };
  return {
    home: randInt(range.home[0], range.home[1]),
    away: randInt(range.away[0], range.away[1])
  };
}

// Hybrid resolution: spreads & totals decided by the score; moneyline (and
// anything we can't structurally identify) falls back to a 50/50 coin flip.
function determineOutcome(pickLabel, gameBetDefs, homeScore, awayScore) {
  const def = (gameBetDefs || []).find(b => b && b.label === pickLabel);
  if (!def) {
    return Math.random() < 0.5 ? 'won' : 'lost';
  }

  if (def.type === 'total') {
    const total = homeScore + awayScore;
    if (def.direction === 'over')  return total >  def.line ? 'won' : 'lost';
    if (def.direction === 'under') return total <  def.line ? 'won' : 'lost';
    return Math.random() < 0.5 ? 'won' : 'lost';
  }

  if (def.type === 'spread') {
    // home -3.5 wins if (home - away) > 3.5  -> margin + line > 0
    // away +3.5 wins if (away - home) > -3.5 -> margin + line > 0
    const margin = def.side === 'home'
      ? (homeScore - awayScore)
      : (awayScore - homeScore);
    return (margin + def.line) > 0 ? 'won' : 'lost';
  }

  // moneyline / props / unknown -> random per design choice
  return Math.random() < 0.5 ? 'won' : 'lost';
}

// Build a fresh set of structured bets for a sport between two teams.
function generateBetsForSport(home, away, sport) {
  const lineConfig = {
    Football:   { spread: [3, 6.5, 7, 10], total: [42, 45, 48] },
    Basketball: { spread: [3, 6, 8, 10],   total: [210, 220, 225] },
    Hockey:     { spread: [1, 1.5, 2],     total: [5.5, 6, 6.5] },
    Baseball:   { spread: [1, 1.5, 2],     total: [7.5, 8, 9] },
    Soccer:     { spread: [0.5, 1, 1.5],   total: [2.5, 3] },
    Curling:    { spread: [1, 2, 3],       total: [12, 14] }
  };

  // Boxing is moneyline-only.
  if (sport === 'Boxing' || !lineConfig[sport]) {
    return [
      { label: `${home} -150`, type: 'moneyline', side: 'home', odds: -150 },
      { label: `${away} +130`, type: 'moneyline', side: 'away', odds:  130 }
    ];
  }

  const cfg    = lineConfig[sport];
  const spread = randPick(cfg.spread);
  const total  = randPick(cfg.total);

  return [
    { label: `${home} -${spread}`, type: 'spread', side: 'home', line: -spread, odds: -110 },
    { label: `${away} +${spread}`, type: 'spread', side: 'away', line:  spread, odds: -110 },
    { label: `Over ${total}`,      type: 'total',  direction: 'over',  line: total, odds: -110 },
    { label: `Under ${total}`,     type: 'total',  direction: 'under', line: total, odds: -110 }
  ];
}
// ============================================================================
// TIMER REGISTRY
// One game can have a go-live timer + an end-game timer at the same time.
// Keep a registry so re-scheduling on boot can cancel previous ones.
// ============================================================================
const activeTimers = new Map(); // gameId -> { goLive, endGame }

function cancelAllTimers() {
  for (const t of activeTimers.values()) {
    if (t.goLive)  clearTimeout(t.goLive);
    if (t.endGame) clearTimeout(t.endGame);
  }
  activeTimers.clear();
}

function scheduleGoLive(gameId, delayMs) {
  if (!activeTimers.has(gameId)) activeTimers.set(gameId, {});
  const t = activeTimers.get(gameId);
  if (t.goLive) clearTimeout(t.goLive);
  t.goLive = setTimeout(() => goLive(gameId).catch(console.error), Math.max(0, delayMs));
}

function scheduleEndGame(gameId, delayMs) {
  if (!activeTimers.has(gameId)) activeTimers.set(gameId, {});
  const t = activeTimers.get(gameId);
  if (t.endGame) clearTimeout(t.endGame);
  t.endGame = setTimeout(() => endGame(gameId).catch(console.error), Math.max(0, delayMs));
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

  console.log(`[lifecycle] ${game.name} FINISHED ${score.home} - ${score.away}.`);

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

  // This game's timers are done - drop them from the registry.
  activeTimers.delete(gameId);

  // Enforce the at-most-1-finished rule.
  await enforceFinishedLimit();
}

// If 2+ games are finished, delete the oldest one and create a replacement
// upcoming game between its same two teams in a different sport.
async function enforceFinishedLimit() {
  const finished = await dbAll(
    // Put NULL end_times first (they're effectively the oldest), then
    // earliest end_time. SQLite doesn't have NULLS FIRST so we fake it.
    `SELECT * FROM games
       WHERE status = 'finished'
       ORDER BY (end_time IS NULL) DESC, end_time ASC`
  );

  if (finished.length < 2) return;

  const oldest = finished[0];
  await dbRun(`DELETE FROM games WHERE id = ?`, [oldest.id]);
  console.log(`[lifecycle] Removed oldest finished game: ${oldest.name} (${oldest.sport}).`);

  // Replace with a new upcoming game between the same two teams in a
  // different sport. Regular 1-hour cycle.
  const [home, away] = (oldest.name || '').split(' vs ');
  const candidates = ALL_SPORTS.filter(s => s !== oldest.sport);
  const newSport = randPick(candidates) || 'Soccer';
  const newBets  = generateBetsForSport(home || 'Home', away || 'Away', newSport);

  const maxRow = await dbGet(`SELECT MAX(id) AS max FROM games`);
  const newId  = (maxRow && maxRow.max ? maxRow.max : 0) + 1;

  const now = Date.now();
  const startDelayMs = FIVE_MIN;          // start in 5 min
  const endDelayMs   = startDelayMs + ONE_HOUR; // 1-hour duration

  await dbRun(
    `INSERT INTO games (id, name, sport, status, bets, start_time, end_time)
     VALUES (?, ?, ?, 'upcoming', ?, ?, ?)`,
    [
      newId,
      oldest.name,
      newSport,
      JSON.stringify(newBets),
      new Date(now + startDelayMs).toISOString(),
      new Date(now + endDelayMs).toISOString()
    ]
  );

  scheduleGoLive(newId, startDelayMs);
  scheduleEndGame(newId, endDelayMs);

  console.log(`[lifecycle] Replacement created: ${oldest.name} now playing ${newSport} (id=${newId}, starts in 5 min).`);
}

// ============================================================================
// BOOT
// Always reset to the demo state on every server boot.
// Render's free tier spins the server down after idle, so each "real" boot
// gives a user a fresh 5-min demo window to bet+payout in.
// ============================================================================
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
    cancelAllTimers();

    const games = await dbAll(`SELECT * FROM games ORDER BY id ASC`);
    if (games.length === 0) {
      console.log('[lifecycle] No games in DB. Run `npm run init-db` first.');
      return;
    }

    const now = Date.now();

    // Slot assignment: pick the first existing finished game (or game 1) as
    // the "already finished" slot, then walk the rest as live / demo /
    // regular(s).
    let finished = null;
    let live = null;
    let demo = null;
    const regulars = [];

    for (const g of games) {
      if (!finished && (g.status === 'finished' || g.home_score != null)) {
        finished = g;
      } else if (!live)  live = g;
      else if (!demo)    demo = g;
      else               regulars.push(g);
    }
    // Fallback if nothing was already finished: take the first game.
    if (!finished && games.length > 0) {
      finished = games[0];
      live = null; demo = null; regulars.length = 0;
      for (let i = 1; i < games.length; i++) {
        if (!live)  { live = games[i]; continue; }
        if (!demo)  { demo = games[i]; continue; }
        regulars.push(games[i]);
      }
    }

    // Slot 1: finished. Make sure it has a score and an end_time so the
    // "remove oldest finished" logic can sort by end_time later.
    if (finished) {
      let homeScore = finished.home_score;
      let awayScore = finished.away_score;
      if (homeScore == null || awayScore == null) {
        const s = generateScore(finished.sport);
        homeScore = s.home; awayScore = s.away;
      }
      const finishedEndTime = new Date(now - ONE_HOUR).toISOString();
      await dbRun(
        `UPDATE games
            SET status = 'finished',
                home_score = ?,
                away_score = ?,
                end_time = ?
          WHERE id = ?`,
        [homeScore, awayScore, finishedEndTime, finished.id]
      );
      console.log(`[lifecycle] Slot 1 FINISHED: ${finished.name} (${finished.sport}) ${homeScore}-${awayScore}.`);
    }

    // Slot 2: live, 30 min remaining.
    if (live) {
      const startTime = new Date(now - THIRTY_MIN).toISOString(); // started 30 min ago
      const endTime   = new Date(now + THIRTY_MIN).toISOString(); // ends in 30 min
      await dbRun(
        `UPDATE games
            SET status = 'live',
                start_time = ?,
                end_time   = ?,
                home_score = NULL,
                away_score = NULL
          WHERE id = ?`,
        [startTime, endTime, live.id]
      );
      scheduleEndGame(live.id, THIRTY_MIN);
      console.log(`[lifecycle] Slot 2 LIVE: ${live.name} (${live.sport}), ends in 30 min.`);
    }

    // Slot 3: short demo. Starts in 5 min, lasts 1 min (ends 6 min from boot).
    if (demo) {
      const startTime = new Date(now + DEMO_START_DELAY_MS).toISOString();
      const endTime   = new Date(now + DEMO_END_DELAY_MS).toISOString();
      await dbRun(
        `UPDATE games
            SET status = 'upcoming',
                start_time = ?,
                end_time   = ?,
                home_score = NULL,
                away_score = NULL
          WHERE id = ?`,
        [startTime, endTime, demo.id]
      );
      scheduleGoLive(demo.id,  DEMO_START_DELAY_MS);
      scheduleEndGame(demo.id, DEMO_END_DELAY_MS);
      console.log(`[lifecycle] Slot 3 DEMO: ${demo.name} (${demo.sport}), starts in 5 min, lasts 1 min.`);
    }

    // Slot 4+: regular upcoming games. Stagger start times so they don't
    // all fire at once (first one in 1 hr, then +30 min each after that).
    for (let i = 0; i < regulars.length; i++) {
      const g = regulars[i];
      const startDelayMs = ONE_HOUR + i * THIRTY_MIN;
      const endDelayMs   = startDelayMs + ONE_HOUR;
      const startTime = new Date(now + startDelayMs).toISOString();
      const endTime   = new Date(now + endDelayMs).toISOString();
      await dbRun(
        `UPDATE games
            SET status = 'upcoming',
                start_time = ?,
                end_time   = ?,
                home_score = NULL,
                away_score = NULL
          WHERE id = ?`,
        [startTime, endTime, g.id]
      );
      scheduleGoLive(g.id,  startDelayMs);
      scheduleEndGame(g.id, endDelayMs);
      const minsToStart = Math.round(startDelayMs / 60000);
      console.log(`[lifecycle] Slot ${4 + i} REGULAR: ${g.name} (${g.sport}), starts in ${minsToStart} min.`);
    }
  } catch (err) {
    console.error('[lifecycle] boot failed:', err);
  }
}

// ============================================================================
// ROUTES
// API endpoints that the frontend calls to interact with the backend
// These routes handle profile data, balances, bets, authentication, and game.
// ============================================================================

// Basic test route to confirm the backend server is online
app.get('/', (req, res) => {
  res.send('DraftBots backend is running.');
});

// ============================================================================
// PROFILE ROUTE
// // ============================================================================

// Returns the profile information and transaction history for a user
app.get('/api/profile', (req, res) => {
  // Gets the username from the query string
  const { username } = req.query;

  // Rejects the request if no username was provided.
  if (!username) {
    return res.status(400).json({ error: 'Username is required.' });
  }

  // Look up the user's profile information in the database
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

      // Load the user's transaction history
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

          // Send the completed profile response back to the frontend
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

// ============================================================================
// ADD FUNDS ROUTE
// ============================================================================

app.post('/api/add-funds', (req, res) => {
  // Read the submitted username and amount, then convert amount into a number
  const { username, amount } = req.body;
  const deposit = Number(amount);

  // Validate, the value just has to be a positive number
  if (!username || !Number.isFinite(deposit) || deposit <= 0) {
    return res.status(400).json({ error: 'Valid username and amount are required.' });
  }

  // Generate today's date for the transaction history
  const today = new Date().toISOString().split('T')[0];

  // look up the user in the database
  db.get(
    `SELECT id, balance FROM users WHERE username = ?`,
    [username],
    (err, user) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to load user.' });
      }
      if (!user) return res.status(404).json({ error: 'User not found.' });

      // Calculate the updated balance to 2 decimal places
      const newBalance = +(Number(user.balance) + deposit).toFixed(2);

      // serialize() keeps the commands in order
      db.serialize(() => {
        // Begins the transaction, helps to prevent partial updates if something goes wrong
        db.run('BEGIN TRANSACTION');

        // Updates the user's balance
        db.run(
          `UPDATE users SET balance = ? WHERE id = ?`,
          [newBalance, user.id]
        );

        // Insert a transaction history entry
        db.run(
          `INSERT INTO transactions (user_id, type, amount, date)
           VALUES (?, 'Deposit', ?, ?)`,
          [user.id, deposit, today]
        );

        // Finalize all changes
        db.run('COMMIT', (err) => {
          if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to add funds.' });
          }

          // Send the updated balance back to the frontend
          res.json({
            message: 'Funds added successfully.',
            balance: newBalance
          });
        });
      });
    }
  );
});

// ============================================================================
// BETS ROUTE
// ============================================================================
// Returns all bets placed by a specific user.
app.get('/api/bets', (req, res) => {

  // Read username from the query string.
  // Example: /api/bets?username=tyler
  const { username } = req.query;

  // Reject request if username was not provided.
  if (!username) {
    return res.status(400).json({
      error: 'Username is required.'
    });
  }

  // Load all bets associated with the user.
  db.all(
    `SELECT b.id, b.game, b.sport, b.pick, b.amount, b.odds, b.payout, b.status, b.date
       FROM bets b
       JOIN users u ON b.user_id = u.id
      WHERE u.username = ?
      ORDER BY b.id DESC`,
    [username],

    // Callback runs after the database query finishes.
    (err, bets) => {

      // Handle database query errors.
      if (err) {
        console.error(err);
        return res.status(500).json({
          error: 'Failed to load bets'
        });
      }

      // Return all bets to the frontend.
      res.json(bets);
    }
  );
});

// ============================================================================
// GAMES ROUTE
// ============================================================================
// Returns all games, including lifecycle timing and final scores.
app.get('/api/games', (req, res) => {

  // Load all games from the database.
  db.all(
    `SELECT id, name, sport, status, bets, start_time, end_time, home_score, away_score
       FROM games
      ORDER BY
        CASE status
          WHEN 'live'     THEN 0
          WHEN 'upcoming' THEN 1
          WHEN 'finished' THEN 2
          ELSE 3
        END,
        id ASC`,

    // Callback runs after the database query finishes.
    (err, rows) => {

      // Handle database query errors.
      if (err) {
        console.error(err);
        return res.status(500).json({
          error: 'Failed to load games'
        });
      }

      // Convert database rows into frontend-friendly objects.
      const games = rows.map(row => {

        // Stored bets are saved as JSON strings in SQLite.
        // Convert them back into JavaScript arrays.
        let bets = [];

        try {
          bets = JSON.parse(row.bets || '[]');
        } catch (_) {

          // If parsing fails, safely fall back to an empty array.
          bets = [];
        }

        // Return cleaned game object.
        return {
          id: row.id,
          name: row.name,
          sport: row.sport,
          status: row.status,
          bets,

          // Lifecycle timing.
          startTime: row.start_time,
          endTime: row.end_time,

          // Final score values.
          homeScore: row.home_score,
          awayScore: row.away_score
        };
      });

      // Send games array back to frontend.
      res.json(games);
    }
  );
});

// ============================================================================
// REGISTER ROUTE
// ============================================================================
// Creates a new user account.
app.post('/api/register', (req, res) => {

  // Read registration form values from the request body.
  const { username, email, password } = req.body;

  // Validate required fields.
  if (!username || !email || !password) {
    return res.status(400).json({
      error: 'All fields are required.'
    });
  }

  // Hash password before storing it in the database.
  const hashed = hashPassword(password);

  // Generate today's date for account creation.
  const today = new Date().toISOString().split('T')[0];

  // Insert the new user into the database.
  db.run(
    `INSERT INTO users (username, email, created_at, status, balance, password)
     VALUES (?, ?, ?, 'Active', 100.00, ?)`,
    [username, email, today, hashed],

    // Callback runs after INSERT finishes.
    function (err) {

      // Handle duplicate usernames.
      if (err) {

        if (err.message.includes('UNIQUE')) {
          return res.status(409).json({
            error: 'Username already taken.'
          });
        }

        // Handle general registration errors.
        console.error(err);

        return res.status(500).json({
          error: 'Registration failed.'
        });
      }

      // Return success response.
      res.status(201).json({
        message: 'Account created successfully.'
      });
    }
  );
});

// ============================================================================
// LOGIN ROUTE
// ============================================================================
// Verifies username and password credentials.
app.post('/api/login', (req, res) => {

  // Read login credentials from the request body.
  const { username, password } = req.body;

  // Validate required fields.
  if (!username || !password) {
    return res.status(400).json({
      error: 'Username and password are required.'
    });
  }

  // Hash submitted password for comparison with database.
  const hashed = hashPassword(password);

  // Attempt to find a matching user.
  db.get(
    `SELECT id, username, email, status, balance
       FROM users
      WHERE username = ? AND password = ?`,
    [username, hashed],

    // Callback runs after database lookup finishes.
    (err, user) => {

      // Handle database errors.
      if (err) {
        console.error(err);

        return res.status(500).json({
          error: 'Login failed.'
        });
      }

      // Reject invalid login credentials.
      if (!user) {
        return res.status(401).json({
          error: 'Invalid username or password.'
        });
      }

      // Return logged-in user information.
      res.json({
        username: user.username,
        email: user.email,
        status: user.status,
        balance: user.balance
      });
    }
  );
});

// ============================================================================
// PLACE BET ROUTE
// ============================================================================
// Places a new bet and removes money from the user's balance.
app.post('/api/place-bet', (req, res) => {

  // Read submitted bet data from the frontend.
  const { username, gameId, pick, amount } = req.body;

  // Validate required fields.
  if (!username || !gameId || !pick || amount === undefined) {
    return res.status(400).json({
      error: 'All fields are required.'
    });
  }

  // Convert wager into a number.
  const wager = Number(amount);

  // Ensure wager is valid and positive.
  if (!Number.isFinite(wager) || wager <= 0) {
    return res.status(400).json({
      error: 'Wager must be greater than 0.'
    });
  }

  // Generate today's date for transaction history.
  const today = new Date().toISOString().split('T')[0];

  // Find the user placing the bet.
  db.get(
    `SELECT id, balance FROM users WHERE username = ?`,
    [username],

    // Callback after user lookup finishes.
    (err, user) => {

      // Handle database errors.
      if (err) {
        console.error(err);

        return res.status(500).json({
          error: 'Failed to load user.'
        });
      }

      // Reject missing users.
      if (!user) {
        return res.status(404).json({
          error: 'User not found.'
        });
      }

      // Reject wagers larger than available balance.
      if (user.balance < wager) {
        return res.status(400).json({
          error: 'Insufficient balance.'
        });
      }

      // Find the selected game.
      db.get(
        `SELECT id, name, sport, status, bets, start_time
           FROM games
          WHERE id = ?`,
        [gameId],

        // Callback after game lookup finishes.
        (err, game) => {

          // Handle database errors.
          if (err) {
            console.error(err);

            return res.status(500).json({
              error: 'Failed to load game.'
            });
          }

          // Reject invalid game IDs.
          if (!game) {
            return res.status(404).json({
              error: 'Game not found.'
            });
          }

          // Only allow bets before the game starts.
          if (game.status !== 'upcoming') {
            return res.status(400).json({
              error: 'Bets are only allowed on upcoming games.'
            });
          }

          // Extra safety check in case lifecycle timing has not updated yet.
          if (
            game.start_time &&
            Date.now() >= new Date(game.start_time).getTime()
          ) {
            return res.status(400).json({
              error: 'Betting has closed for this game.'
            });
          }

          // Parse valid betting options stored in the game.
          let validPicks = [];

          try {
            validPicks = JSON.parse(game.bets || '[]');

          } catch (parseErr) {

            console.error(parseErr);

            return res.status(500).json({
              error: 'Game bet options are invalid.'
            });
          }

          // Find the exact bet definition selected by the user.
          let betDef = null;

          // New structured betting system.
          if (
            validPicks.length &&
            typeof validPicks[0] === 'object'
          ) {

            betDef = validPicks.find(b => b.label === pick);

            // Reject invalid picks.
            if (!betDef) {
              return res.status(400).json({
                error: 'Invalid pick for this game.'
              });
            }

          } else {

            // Legacy string-only fallback system.
            if (!validPicks.includes(pick)) {
              return res.status(400).json({
                error: 'Invalid pick for this game.'
              });
            }

            betDef = { odds: -110 };
          }

          // Pull betting odds from the definition.
          const odds = betDef.odds;

          // Calculate total payout including original wager.
          const payout = +(odds < 0
            ? wager * (1 + 100 / Math.abs(odds))
            : wager * (1 + odds / 100)
          ).toFixed(2);

          // serialize() forces all database actions to run in order.
          db.serialize(() => {

            // Start transaction to prevent partial updates.
            db.run('BEGIN TRANSACTION');

            // Remove wager from user balance.
            db.run(
              `UPDATE users SET balance = balance - ? WHERE id = ?`,
              [wager, user.id]
            );

            // Insert the bet into betting history.
            db.run(
              `INSERT INTO bets (user_id, game, sport, pick, amount, odds, payout, status, date)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
              [
                user.id,
                game.name,
                game.sport,
                pick,
                wager,
                odds,
                payout,
                today
              ]
            );

            // Insert transaction history entry.
            db.run(
              `INSERT INTO transactions (user_id, type, amount, date)
               VALUES (?, ?, ?, ?)`,
              [
                user.id,
                `Bet - ${pick}`,
                -wager,
                today
              ]
            );

            // Finalize database changes.
            db.run('COMMIT', (err) => {

              // Handle transaction errors.
              if (err) {
                console.error(err);

                return res.status(500).json({
                  error: 'Failed to place bet.'
                });
              }

              // Return completed bet information.
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

// ============================================================================
// CANCEL BET ROUTE
// ============================================================================
// Cancels a pending bet and refunds the wager back to the user's balance.
app.delete('/api/bets/:id', (req, res) => {

  // Get the username from the request body.
  const { username } = req.body;

  // Convert the bet id from the URL into a number.
  // Example: /api/bets/3
  const betId = Number(req.params.id);

  // Make sure a username was provided.
  if (!username) {
    return res.status(400).json({
      error: 'Username is required.'
    });
  }

  // Make sure the bet id is valid.
  if (!Number.isFinite(betId) || betId <= 0) {
    return res.status(400).json({
      error: 'Invalid bet id.'
    });
  }

  // Generate today's date for the refund transaction.
  const today = new Date().toISOString().split('T')[0];

  // Find the user who is trying to cancel the bet.
  db.get(
    `SELECT id, balance FROM users WHERE username = ?`,
    [username],
    (err, user) => {

      // Handle database errors.
      if (err) {
        console.error(err);
        return res.status(500).json({
          error: 'Failed to load user.'
        });
      }

      // Reject request if the user does not exist.
      if (!user) {
        return res.status(404).json({
          error: 'User not found.'
        });
      }

      // Find the bet being cancelled.
      db.get(
        `SELECT id, user_id, game, pick, amount, status FROM bets WHERE id = ?`,
        [betId],
        (err, bet) => {

          // Handle database errors.
          if (err) {
            console.error(err);
            return res.status(500).json({
              error: 'Failed to load bet.'
            });
          }

          // Reject request if the bet does not exist.
          if (!bet) {
            return res.status(404).json({
              error: 'Bet not found.'
            });
          }

          // Make sure the bet belongs to the logged-in user.
          if (bet.user_id !== user.id) {
            return res.status(403).json({
              error: 'You do not own this bet.'
            });
          }

          // Only pending bets can be cancelled.
          if (bet.status !== 'pending') {
            return res.status(400).json({
              error: 'Only pending bets can be cancelled.'
            });
          }

          // Find the game connected to this bet.
          db.get(
            `SELECT id, status, start_time FROM games WHERE name = ?`,
            [bet.game],
            (err, game) => {

              // Handle database errors.
              if (err) {
                console.error(err);
                return res.status(500).json({
                  error: 'Failed to load game.'
                });
              }

              // Reject request if the game does not exist.
              if (!game) {
                return res.status(404).json({
                  error: 'Game not found.'
                });
              }

              // Do not allow cancelling once the game is live or finished.
              if (game.status !== 'upcoming') {
                return res.status(400).json({
                  error: 'Game has already started.'
                });
              }

              // Extra safety check using the scheduled start time.
              if (
                game.start_time &&
                Date.now() >= new Date(game.start_time).getTime()
              ) {
                return res.status(400).json({
                  error: 'Game has already started.'
                });
              }

              // Refund amount is the original wager amount.
              const refund = +Number(bet.amount).toFixed(2);

              // Run cancellation, refund, and transaction insert in order.
              db.serialize(() => {

                // Begin transaction so all updates happen together.
                db.run('BEGIN TRANSACTION');

                // Mark the bet as cancelled.
                db.run(
                  `UPDATE bets SET status = 'cancelled' WHERE id = ?`,
                  [bet.id]
                );

                // Add the refund back to the user's balance.
                db.run(
                  `UPDATE users SET balance = balance + ? WHERE id = ?`,
                  [refund, user.id]
                );

                // Add refund to transaction history.
                db.run(
                  `INSERT INTO transactions (user_id, type, amount, date)
                   VALUES (?, ?, ?, ?)`,
                  [user.id, `Bet Cancelled - ${bet.pick}`, refund, today]
                );

                // Commit all database changes.
                db.run('COMMIT', (err) => {

                  // Handle commit failure.
                  if (err) {
                    console.error(err);
                    return res.status(500).json({
                      error: 'Failed to cancel bet.'
                    });
                  }

                  // Return updated cancellation data to the frontend.
                  res.json({
                    id: bet.id,
                    status: 'cancelled',
                    refunded: refund,
                    newBalance: +(user.balance + refund).toFixed(2)
                  });
                });
              });
            }
          );
        }
      );
    }
  );
});

// ============================================================================
// DEBUG ROUTE
// ============================================================================
// Development-only route that returns raw database contents.
// Useful for checking users, bets, and games while testing locally.
app.get('/api/debug/all', (req, res) => {

  // Load every user from the database.
  db.all('SELECT * FROM users', [], (err, users) => {
    if (err) {
      return res.status(500).json(err);
    }

    // Load every bet from the database.
    db.all('SELECT * FROM bets', [], (err2, bets) => {
      if (err2) {
        return res.status(500).json(err2);
      }

      // Load every game from the database.
      db.all('SELECT * FROM games', [], (err3, games) => {
        if (err3) {
          return res.status(500).json(err3);
        }

        // Return everything together for debugging.
        res.json({
          users,
          bets,
          games
        });
      });
    });
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================
// Starts the backend server and begins the automatic game lifecycle.
app.listen(PORT, () => {

  // Confirm the server is running.
  console.log(`DraftBots backend running on http://localhost:${PORT}`);

  // Start game timers when the backend boots.
  bootLifecycle();
});