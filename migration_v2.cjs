/**
 * Migration v2: Study Group Customizations & Customization Rights
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:RDJTSKVSROKP1111@db.ukseqpubzzzjvuyjqivp.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🚀 Starting migration v2...');

    await client.query(`ALTER TABLE study_groups ADD COLUMN IF NOT EXISTS theme_color VARCHAR(50) DEFAULT 'indigo';`);
    console.log('  ✅ study_groups.theme_color');

    await client.query(`ALTER TABLE study_groups ADD COLUMN IF NOT EXISTS avatar_emoji VARCHAR(50) DEFAULT '📚';`);
    console.log('  ✅ study_groups.avatar_emoji');

    await client.query(`ALTER TABLE study_groups ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT FALSE;`);
    console.log('  ✅ study_groups.is_private');

    await client.query(`ALTER TABLE study_groups ADD COLUMN IF NOT EXISTS allow_member_invites BOOLEAN DEFAULT TRUE;`);
    console.log('  ✅ study_groups.allow_member_invites');

    await client.query(`ALTER TABLE study_group_members ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;`);
    console.log('  ✅ study_group_members.is_admin');

    await client.query(`
      UPDATE study_group_members sgm
      SET is_admin = TRUE
      FROM study_groups sg
      WHERE sgm.group_id = sg.id AND sgm.user_id = sg.creator_id AND sgm.is_admin = FALSE;
    `);
    console.log('  ✅ Existing group creators set as admin');

    await client.query(`
      CREATE TABLE IF NOT EXISTS group_shared_notes (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
        note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        pinned_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pinned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, note_id)
      );
    `);
    console.log('  ✅ group_shared_notes table');

    await client.query(`
      CREATE TABLE IF NOT EXISTS group_goals (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
        is_completed BOOLEAN DEFAULT FALSE,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      );
    `);
    console.log('  ✅ group_goals table');

    await client.query(`
      CREATE TABLE IF NOT EXISTS group_meets (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        scheduled_at TIMESTAMP NOT NULL,
        duration_minutes INTEGER DEFAULT 60,
        meet_type VARCHAR(20) DEFAULT 'voice',
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('  ✅ group_meets table');

    console.log('\n🎉 Migration v2 completed successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error(err);
  process.exit(1);
});
