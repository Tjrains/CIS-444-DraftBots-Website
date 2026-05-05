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
// flow within ~2.5 min of server boot.
const DEMO_START_DELAY_MS = 2 * 60 * 1000; // game starts 2 min after boot
const DEMO_DURATION_MS    = 30 * 1000;     // game lasts 30 sec
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

// ----- timer registry -----
// One game can have a go-live timer + an end-game timer at the same time.
// Keep a registry so re-scheduling on boot can cancel previous ones.
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

// ----- boot -----
// Always reset to the demo state on every server boot.
// Render's free tier spins the server down after idle, so each "real" boot
// gives a user a fresh 5-min demo window to bet+payout in.
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

    // Slot 3: short demo. Starts in 2 min, lasts 30 sec (ends 2.5 min from boot).
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
      console.log(`[lifecycle] Slot 3 DEMO: ${demo.name} (${demo.sport}), starts in 2 min, lasts 30 sec.`);
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

// GAMES — returns lifecycle timestamps and final scores
app.get('/api/games', (req, res) => {
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
          // Defensive: refuse any bet placed at or after the scheduled lock
          // time, even if the status flip hasn't fired yet.
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
