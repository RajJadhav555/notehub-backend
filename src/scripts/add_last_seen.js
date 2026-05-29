const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function migrate() {
  try {
    console.log('🔄 Application Online Status Migration...');

    // Add last_seen column if it doesn't exist
    try {
        await pool.query(`ALTER TABLE users ADD COLUMN last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
        console.log('   - Added last_seen column to users table');
    } catch (e) {
        if (e.message.includes('already exists')) {
            console.log('   - last_seen column already exists');
        } else {
            console.error('   × Error adding column:', e.message);
        }
    }

    console.log('✅ Migration Complete!');
  } catch (e) {
    console.error('❌ Migration Failed:', e);
  } finally {
    pool.end();
  }
}

migrate();
