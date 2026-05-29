const pool = require('../db');

async function checkLeaderboardSchema() {
  try {
    const res = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'leaderboard';
    `);
    console.log('Leaderboard Indexes:');
    console.table(res.rows);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkLeaderboardSchema();
