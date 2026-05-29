const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const pool = new Pool({
  user: 'notehub_user',
  host: 'localhost',
  database: 'notehub_database',
  password: 'notehub_password',
  port: 5432
});

async function migrate() {
  try {
    console.log('🔄 Adding password_hash column to users table...');
    
    // Check if column already exists
    const checkColumn = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'password_hash'
    `);
    
    if (checkColumn.rows.length > 0) {
      console.log('✅ Column password_hash already exists. Skipping migration.');
    } else {
      // Add the password_hash column
      await pool.query(`
        ALTER TABLE users 
        ADD COLUMN password_hash VARCHAR(255)
      `);
      console.log('✅ Successfully added password_hash column to users table.');
    }
    
    // Verify the column was added
    const verifyResult = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'password_hash'
    `);
    
    if (verifyResult.rows.length > 0) {
      console.log('✅ Verified: password_hash column exists with type:', verifyResult.rows[0].data_type);
    }
    
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    throw err;
  } finally {
    await pool.end();
  }
}

migrate()
  .then(() => {
    console.log('🎉 Migration complete!');
    process.exit(0);
  })
  .catch(() => {
    process.exit(1);
  });
