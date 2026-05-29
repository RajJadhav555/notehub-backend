const pool = require('../src/db');
const path = require('path');

async function migrate() {
  try {
    console.log('Adding "year" column to users table...');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS year VARCHAR(50)');
    console.log('Successfully added "year" column.');
  } catch (err) {
    console.error('Error adding column:', err);
  } finally {
    // We don't want to end the pool if other parts of the app are using it, 
    // but since this is a script, we force exit after a short delay
    setTimeout(() => {
        pool.end();
        process.exit(0);
    }, 1000);
  }
}

migrate();
