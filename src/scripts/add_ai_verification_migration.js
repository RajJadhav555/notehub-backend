// Run database migration for AI verification columns
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.DB_HOST || '127.0.0.1',
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: process.env.DB_PORT || 5433,
});

const migrationSQL = `
-- Add verification status column
ALTER TABLE notes 
ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) DEFAULT 'pending';

-- Add AI verification score column
ALTER TABLE notes 
ADD COLUMN IF NOT EXISTS ai_verification_score INTEGER DEFAULT 0;

-- Add verification details column (stores JSON)
ALTER TABLE notes 
ADD COLUMN IF NOT EXISTS verification_details JSONB;

-- Add verified_at timestamp
ALTER TABLE notes 
ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;

-- Add verified_by column (to track if AI or admin verified)
ALTER TABLE notes 
ADD COLUMN IF NOT EXISTS verified_by VARCHAR(50) DEFAULT 'ai_system';

-- Create index for faster queries on verification status
CREATE INDEX IF NOT EXISTS idx_notes_verification_status ON notes(verification_status);

-- Update existing notes to have default verification status
UPDATE notes 
SET verification_status = CASE 
    WHEN verified = true THEN 'auto_approved'
    ELSE 'manual_review'
END
WHERE verification_status IS NULL OR verification_status = 'pending';
`;

async function runMigration() {
  const client = await pool.connect();
  try {
    console.log('🔄 Running database migration...');
    console.log('Database:', process.env.POSTGRES_DB);
    console.log('Host:', process.env.DB_HOST || '127.0.0.1');
    console.log('Port:', process.env.DB_PORT || 5433);
    
    await client.query(migrationSQL);
    
    console.log('✅ Migration completed successfully!');
    console.log('\nNew columns added to notes table:');
    console.log('  - verification_status (VARCHAR)');
    console.log('  - ai_verification_score (INTEGER)');
    console.log('  - verification_details (JSONB)');
    console.log('  - verified_at (TIMESTAMP)');
    console.log('  - verified_by (VARCHAR)');
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
