const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

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

app.listen(PORT, () => {
  console.log(`DraftBots backend running on http://localhost:${PORT}`);
});