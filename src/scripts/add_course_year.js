const pool = require('../db');

async function migrate() {
  try {
    console.log('🔌 Connecting to DB...');
    // const client = await pool.connect(); // use pool directly or connect
    // pool.query is shorthand
    
    console.log('🛠️ Adding course and year columns to notes table...');
    
    await pool.query(`
      ALTER TABLE notes 
      ADD COLUMN IF NOT EXISTS course VARCHAR(255),
      ADD COLUMN IF NOT EXISTS year VARCHAR(50);
    `);
    
    console.log('✅ Columns added successfully!');
    // pool.end(); // Don't close shared pool abruptly in this script context if imported? 
    // Actually standalone script should close.
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();
