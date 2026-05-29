const pool = require('../db');

async function fixSchema() {
  try {
    console.log('🔧 Starting Schema Fix...');

    // 1. Add current_session_token
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS current_session_token VARCHAR(255);
    `);
    console.log('✅ Added/Verified column: current_session_token');

    // 2. Add last_seen
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
    `);
    console.log('✅ Added/Verified column: last_seen');

    // 3. Add updated_at
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
    `);
    console.log('✅ Added/Verified column: updated_at');

    console.log('🎉 Schema fix completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Schema Fix Failed:', err);
    process.exit(1);
  }
}

fixSchema();
