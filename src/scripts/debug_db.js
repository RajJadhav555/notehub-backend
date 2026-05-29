const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost', // Or 'db' if running inside docker, but we are running from host? 
  // Wait, user is on Windows running Node. Backend runs in Docker?
  // If backend runs in Docker, localhost:5432 might be mapped. 
  // The docker-compose.yml says:
  // ports: - "5432:5432"
  database: 'notehub',
  password: 'password',
  port: 5432,
});

async function checkDB() {
  try {
    console.log("🔍 Checking Database...");
    
    const notesRes = await pool.query("SELECT COUNT(*) as count FROM notes");
    console.log(`📝 Total Notes: ${notesRes.rows[0].count}`);

    const verifiedRes = await pool.query("SELECT COUNT(*) as count FROM notes WHERE verified = true");
    console.log(`✅ Verified Notes: ${verifiedRes.rows[0].count}`);

    const leaderboardRes = await pool.query("SELECT COUNT(*) as count FROM leaderboard");
    console.log(`🏆 Leaderboard Entries: ${leaderboardRes.rows[0].count}`);
    
    const usersRes = await pool.query("SELECT COUNT(*) as count FROM users");
    console.log(`👥 Users: ${usersRes.rows[0].count}`);
    
    // Check one user details if exists
    const sample = await pool.query("SELECT * FROM leaderboard LIMIT 1");
    if(sample.rows.length > 0) {
        console.log("Sample Leaderboard Entry:", sample.rows[0]);
    }

  } catch (err) {
    console.error("❌ Error querying DB:", err);
  } finally {
    await pool.end();
  }
}

checkDB();
