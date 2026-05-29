const pool = require('../db');

async function fixLeaderboard() {
  try {
    console.log('🔧 Fixing Leaderboard Schema...');
    
    // 1. Clear bad data (duplicates) first to avoid errors when adding constraint
    console.log('Cleaning up potential duplicates...');
    await pool.query('TRUNCATE TABLE leaderboard'); 

    // 2. Add Unique Constraint
    console.log('Adding UNIQUE constraint to user_id...');
    await pool.query('ALTER TABLE leaderboard ADD CONSTRAINT leaderboard_user_id_key UNIQUE (user_id)');
    
    console.log('✅ Leaderboard schema fixed & cleared.');
    process.exit(0);
  } catch (err) {
    if (err.message.includes('already exists')) {
        console.log('✅ Constraint "leaderboard_user_id_key" already exists.');
        process.exit(0);
    }
    console.error('❌ Failed to fix leaderboard:', err);
    process.exit(1);
  }
}

fixLeaderboard();
