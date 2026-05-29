
require('dotenv').config({ path: '../../.env' });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function migrate() {
  try {
    console.log('Adding current_session_token column to users table...');
    
    // Check if column exists
    const checkRes = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='users' AND column_name='current_session_token'
    `);

    if (checkRes.rows.length === 0) {
      await pool.query(`
        ALTER TABLE users 
        ADD COLUMN current_session_token VARCHAR(255);
      `);
      console.log('Column added successfully.');
    } else {
      console.log('Column already exists, skipping.');
    }

    console.log('Migration complete.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await pool.end();
  }
}

migrate();
