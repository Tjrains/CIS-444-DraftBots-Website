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
  db.get(
    `SELECT id, username, email, created_at, status, balance
     FROM users
     WHERE id = 1`,
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
  db.all(
    `SELECT id, game, sport, pick, amount, odds, payout, status, date
     FROM bets
     WHERE user_id = 1
     ORDER BY id DESC`,
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

app.listen(PORT, () => {
  console.log(`DraftBots backend running on http://localhost:${PORT}`);
});