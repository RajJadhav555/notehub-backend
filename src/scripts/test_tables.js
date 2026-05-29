const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  user: process.env.POSTGRES_USER || 'notehub_user',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.POSTGRES_DB || 'notehub_database',
  password: process.env.POSTGRES_PASSWORD || 'notehub_password_123',
  port: process.env.DB_PORT || 5432,
});

async function checkTables() {
  try {
    console.log("🔍 Checking Users Table...");
    const userRes = await pool.query("SELECT * FROM users LIMIT 1");
    console.log(`✅ Users Table Accessible. Count: ${userRes.rowCount}`);
    if (userRes.rows.length > 0) console.log("Sample User:", userRes.rows[0]);

    console.log("\n🔍 Checking Leaderboard Table...");
    const lbRes = await pool.query("SELECT * FROM leaderboard LIMIT 1");
    console.log(`✅ Leaderboard Table Accessible. Count: ${lbRes.rowCount}`);

    console.log("\n🔍 Checking DB Connection Settings:");
    console.log("DB_HOST:", process.env.DB_HOST);
    console.log("User:", process.env.POSTGRES_USER);

  } catch (err) {
    console.error("❌ DB Query Error:", err);
  } finally {
    pool.end();
  }
}

checkTables();
