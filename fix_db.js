require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function fix() {
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
    console.log("Successfully added last_seen column to users table!");
  } catch (e) {
    console.error("Error:", e);
  } finally {
    pool.end();
  }
}
fix();
