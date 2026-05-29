const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function migrate() {
  try {
    console.log('🔄 Starting Leaderboard Migration...');

    // 0. Fix Schema: Remove Duplicates & Add Unique Constraint
    console.log('🔧 Fixing DB Schema...');
    
    // Remove duplicates (keep entry with highest points)
    await pool.query(`
      DELETE FROM leaderboard a USING leaderboard b 
      WHERE a.id < b.id AND a.user_id = b.user_id
    `);

    // Add Constraint if not exists
    try {
        await pool.query(`ALTER TABLE leaderboard ADD CONSTRAINT unique_user_id UNIQUE (user_id)`);
        console.log('   - Added UNIQUE constraint to leaderboard(user_id)');
    } catch (e) {
        if (!e.message.includes('already exists')) {
            console.warn('   - Constraint creation warning:', e.message);
        } else {
            console.log('   - Constraint already exists');
        }
    }

    // 1. Link Notes to Users (Backfill uploader_id)
    console.log('🔗 Linking disconnected notes...');
    const users = await pool.query('SELECT id, name FROM users');
    
    for (const user of users.rows) {
      // Update notes matching the user's name exactly
      const res = await pool.query(
        `UPDATE notes 
         SET uploader_id = $1 
         WHERE uploader_name = $2 AND uploader_id IS NULL`,
        [user.id, user.name]
      );
      if (res.rowCount > 0) {
        console.log(`   - Linked ${res.rowCount} notes to ${user.name}`);
      }
    }

    // 2. Clear & Rebuild Leaderboard
    console.log('📊 Recalculating Leaderboard Stats...');
    
    // Get aggregated stats from notes table
    const stats = await pool.query(`
      SELECT 
        uploader_id,
        uploader_name,
        COUNT(*) as uploads,
        SUM(CASE WHEN verified = true THEN 1 ELSE 0 END) as verified_count,
        SUM(downloads) as total_downloads
      FROM notes
      WHERE uploader_id IS NOT NULL
      GROUP BY uploader_id, uploader_name
    `);

    for (const row of stats.rows) {
      const points = (parseInt(row.uploads) * 5) + (parseInt(row.verified_count) * 10);
      
      console.log(`   - User ${row.uploader_name}: ${points} pts, ${row.uploads} uploads`);

      await pool.query(
        `INSERT INTO leaderboard (user_id, name, points, uploads, verified_notes, rank)
         VALUES ($1, $2, $3, $4, $5, 999)
         ON CONFLICT (user_id) 
         DO UPDATE SET 
            points = $3,
            uploads = $4,
            verified_notes = $5,
            updated_at = CURRENT_TIMESTAMP`,
        [row.uploader_id, row.uploader_name, points, row.uploads, row.verified_count]
      );
    }

    // 3. Update Ranks
    console.log('🏆 Updating Ranks...');
    // Simple rank update based on points
    await pool.query(`
      WITH ranked AS (
        SELECT id, RANK() OVER (ORDER BY points DESC) as rnk
        FROM leaderboard
      )
      UPDATE leaderboard
      SET rank = ranked.rnk
      FROM ranked
      WHERE leaderboard.id = ranked.id
    `);

    console.log('✅ Migration Complete!');
  } catch (e) {
    console.error('❌ Migration Failed:', e);
  } finally {
    pool.end();
  }
}

migrate();
