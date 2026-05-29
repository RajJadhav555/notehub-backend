const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();

// Get leaderboard
router.get('/', async (req, res) => {
  try {
    // 1. Get winning department first based on base points (5 per upload)
    const winningDeptRes = await pool.query(
      `WITH user_base_points AS (
         SELECT u.id, u.department, COALESCE(note_counts.upload_count, 0) * 5 as points
         FROM users u
         LEFT JOIN (
           SELECT uploader_id, COUNT(*) as upload_count 
           FROM notes 
           WHERE verified = true
           GROUP BY uploader_id
         ) note_counts ON u.id = note_counts.uploader_id
       )
       SELECT department, 
              CASE WHEN COUNT(id) > 0 THEN SUM(points)::numeric / COUNT(id) ELSE 0 END as avg_pts
       FROM user_base_points
       WHERE department IS NOT NULL AND department != ''
       GROUP BY department
       ORDER BY avg_pts DESC LIMIT 1`
    );
    
    const winningDept = (winningDeptRes.rows.length > 0 && winningDeptRes.rows[0].avg_pts > 0) 
      ? winningDeptRes.rows[0].department : null;

    // 2. Get leaderboard and apply multiplier to points column
    const result = await pool.query(
      `SELECT 
        l.user_id,
        l.name,
        l.badges,
        l.verified_notes,
        u.last_seen,
        u.department,
        COALESCE(note_counts.upload_count, 0) as uploads,
        ROUND(COALESCE(note_counts.upload_count, 0) * 
          CASE 
            WHEN u.department = $1 AND u.is_verified = true THEN 5.5 
            ELSE 5 
          END, 1) as points,
        CASE 
            WHEN u.last_seen > NOW() - INTERVAL '2 minutes' THEN true 
            ELSE false 
        END as is_online
       FROM leaderboard l
       JOIN users u ON l.user_id = u.id
       LEFT JOIN (
           SELECT uploader_id, COUNT(*) as upload_count 
           FROM notes 
           WHERE verified = true
           GROUP BY uploader_id
       ) note_counts ON l.user_id = note_counts.uploader_id
       ORDER BY points DESC, l.name ASC LIMIT 50`,
      [winningDept]
    );

    // Recalculate ranks based on final (possibly multi-pointed) scores
    const rows = result.rows.map((r, i) => ({ ...r, rank: i + 1 }));

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get department war stats
router.get('/department-war', async (req, res) => {
  try {
    const result = await pool.query(
      `WITH user_points AS (
         SELECT 
           u.id, 
           u.department, 
           COALESCE(note_counts.upload_count, 0) * 5 as points
         FROM users u
         LEFT JOIN (
           SELECT uploader_id, COUNT(*) as upload_count 
           FROM notes 
           WHERE verified = true
           GROUP BY uploader_id
         ) note_counts ON u.id = note_counts.uploader_id
       )
       SELECT 
         department,
         SUM(points) as total_points,
         COUNT(id) as total_users,
         CASE WHEN COUNT(id) > 0 THEN ROUND(SUM(points)::numeric / COUNT(id), 2) ELSE 0 END as average_points
       FROM user_points
       WHERE department IS NOT NULL AND department != ''
       GROUP BY department
       ORDER BY average_points DESC`
    );

    const scores = result.rows.map(row => ({
      ...row,
      average_points: parseFloat(row.average_points)
    }));

    if (scores.length === 0) {
      return res.json({ winningDepartment: null, scores: [] });
    }

    const winningDepartment = scores[0].average_points > 0 ? scores[0].department : null;

    res.json({
      winningDepartment,
      scores
    });
  } catch (err) {
    console.error('Department war error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get user rank
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      'SELECT * FROM leaderboard WHERE user_id = $1',
      [userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found in leaderboard' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Update leaderboard (requires auth)
router.put('/update/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { points, uploads, badges, verified_notes } = req.body;
    
    // First, get the current rank
    const rankResult = await pool.query(
      'SELECT COUNT(*) as rank FROM leaderboard WHERE points > (SELECT points FROM leaderboard WHERE user_id = $1)',
      [userId]
    );
    const newRank = rankResult.rows[0].rank + 1;

    const result = await pool.query(
      `UPDATE leaderboard 
       SET points = $1, uploads = $2, badges = $3, verified_notes = $4, rank = $5, updated_at = CURRENT_TIMESTAMP 
       WHERE user_id = $6 
       RETURNING *`,
      [points, uploads, badges, verified_notes, newRank, userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
