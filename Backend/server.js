const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

//Using SHA-1 for encryption
function hashPassword(plainText) {
  return crypto.createHash('sha1').update(plainText).digest('hex');
}

const dbPath = path.join(__dirname, 'draftbots.db');
const db = new sqlite3.Database(dbPath);

app.get('/', (req, res) => {
  res.send('DraftBots backend is running.');
});

// PROFILE
app.get('/api/profile', (req, res) => {
  const { username } = req.query; // reads ?username=whoever from the URL

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

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

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

// GAMES
app.get('/api/games', (req, res) => {
  db.all(
    `SELECT id, name, sport, status, bets
     FROM games
     ORDER BY id ASC`,
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to load games' });
      }

      const games = rows.map(row => ({
        id: row.id,
        name: row.name,
        sport: row.sport,
        status: row.status,
        bets: JSON.parse(row.bets || '[]')
      }));

      res.json(games);
    }
  );
});

// REGISTER 
app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body;

  // Basic validation
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const hashed = hashPassword(password);
  const today  = new Date().toISOString().split('T')[0]; // e.g. "2026-04-23"

  db.run(
    `INSERT INTO users (username, email, created_at, status, balance, password)
     VALUES (?, ?, ?, 'Active', 100.00, ?)`,
    [username, email, today, hashed],
    function (err) {
      if (err) {
        // The UNIQUE constraint on username will trigger this if taken, needs to be unique
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

      if (!user) {
        return res.status(401).json({ error: 'Invalid username or password.' });
      }

      res.json({
        username: user.username,
        email:    user.email,
        status:   user.status,
        balance:  user.balance
      });
    }
  );
});

// PLACE BET
app.post('/api/place-bet', (req, res) => {
  const { username, gameId, pick, amount } = req.body;

  // Basic validation
  if (!username || !gameId || !pick || amount === undefined) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const wager = Number(amount);
  if (!Number.isFinite(wager) || wager <= 0) {
    return res.status(400).json({ error: 'Wager must be greater than 0.' });
  }

  // Odds hardcoded for now, payout includes the stake
  const odds   = -110;
  const payout = +(wager * (1 + 100 / Math.abs(odds))).toFixed(2);
  const today  = new Date().toISOString().split('T')[0];

  db.get(
    `SELECT id, balance
     FROM users
     WHERE username = ?`,
    [username],
    (err, user) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to load user.' });
      }

      if (!user) {
        return res.status(404).json({ error: 'User not found.' });
      }

      if (user.balance < wager) {
        return res.status(400).json({ error: 'Insufficient balance.' });
      }

      db.get(
        `SELECT id, name, sport, status, bets
         FROM games
         WHERE id = ?`,
        [gameId],
        (err, game) => {
          if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to load game.' });
          }

          if (!game) {
            return res.status(404).json({ error: 'Game not found.' });
          }

          if (game.status !== 'upcoming') {
            return res.status(400).json({ error: 'Bets are only allowed on upcoming games.' });
          }

          const validPicks = JSON.parse(game.bets || '[]');
          if (!validPicks.includes(pick)) {
            return res.status(400).json({ error: 'Invalid pick for this game.' });
          }

          // Decrement balance, insert bet, log transaction — all or nothing
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
                amount:     wager,
                odds,
                payout,
                status:     'pending',
                newBalance: +(user.balance - wager).toFixed(2)
              });
            });
          });
        }
      );
    }
  );
});

app.listen(PORT, () => {
  console.log(`DraftBots backend running on http://localhost:${PORT}`);
});