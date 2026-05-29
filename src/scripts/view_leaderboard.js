const pool = require('../db');

async function showLeaderboard() {
  try {
    const res = await pool.query('SELECT * FROM leaderboard');
    console.log('Leaderboard Data:');
    console.table(res.rows);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

showLeaderboard();
