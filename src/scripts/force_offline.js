const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function forceOffline() {
  try {
    const result = await pool.query(
      "UPDATE users SET last_seen = NOW() - INTERVAL '10 minutes' WHERE name LIKE '%Atharva%'"
    );
    console.log('Atharva forced offline. Rows updated:', result.rowCount);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

forceOffline();
