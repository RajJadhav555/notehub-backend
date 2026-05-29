const pool = require('../db');

async function clearNotes() {
  try {
    console.log('🗑️ Clearing all notes...');
    await pool.query('TRUNCATE TABLE notes CASCADE');
    console.log('✅ All notes deleted successfully.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to clear notes:', err);
    process.exit(1);
  }
}

clearNotes();
