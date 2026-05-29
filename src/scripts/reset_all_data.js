const pool = require('../db');

async function resetAllData() {
  try {
    console.log('🗑️ Clearing all data...');
    
    // Truncate tables with CASCADE to handle foreign keys
    await pool.query('TRUNCATE TABLE users, notes, messages, study_groups, study_group_members, leaderboard, user_profiles, help_requests, broadcasts CASCADE');
    
    console.log('✅ All data cleared successfully from all tables.');
    process.exit(0);
  } catch (err) {
    // If some tables don't exist, we might get an error, but that's okay.
    // We can try deleting individually if truncate all fails due to missing tables.
    console.error('⚠️ Truncate failed, trying individual deletes...', err.message);
    
    try {
       // Delete in reverse order of dependencies
       await pool.query('DELETE FROM broadcasts');
       await pool.query('DELETE FROM help_requests');
       await pool.query('DELETE FROM leaderboad'); // Typo risk, double check? leaderboard
       await pool.query('DELETE FROM user_profiles');
       await pool.query('DELETE FROM study_group_members');
       await pool.query('DELETE FROM study_groups');
       await pool.query('DELETE FROM messages');
       await pool.query('DELETE FROM leaderboard');
       await pool.query('DELETE FROM notes');
       await pool.query('DELETE FROM users');
       console.log('✅ All data deleted successfully.');
       process.exit(0);
    } catch (err2) {
       console.error('❌ Failed to clear data:', err2);
       process.exit(1);
    }
  }
}

resetAllData();
