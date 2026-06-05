const express = require('express');
const pool = require('../db');

const router = express.Router();

// ============ STUDY GROUPS ============

// Get all study groups with member count and is_member flag
router.get('/groups', async (req, res) => {
  try {
    const userId = req.query.userId;
    const result = await pool.query(`
      SELECT 
        sg.*,
        u.name as creator_name,
        COUNT(DISTINCT sgm.user_id) as member_count,
        COUNT(DISTINCT CASE WHEN us.last_seen > NOW() - INTERVAL '2 minutes' THEN sgm.user_id END) as online_count,
        EXISTS(SELECT 1 FROM study_group_members WHERE group_id = sg.id AND user_id = $1) as is_member
      FROM study_groups sg
      LEFT JOIN users u ON sg.creator_id = u.id
      LEFT JOIN study_group_members sgm ON sg.id = sgm.group_id
      LEFT JOIN users us ON sgm.user_id = us.id
      GROUP BY sg.id, u.name
      ORDER BY sg.created_at DESC
    `, [userId || -1]); // Pass -1 if no userId to prevent syntax error (though $1 handles null usually, safe safe)
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Create a study group
router.post('/groups', async (req, res) => {
  try {
    const { name, description, subject, creatorId } = req.body;
    const result = await pool.query(
      `INSERT INTO study_groups (name, description, subject, creator_id) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description, subject, creatorId]
    );
    
    // Auto-join creator to the group
    await pool.query(
      `INSERT INTO study_group_members (group_id, user_id) VALUES ($1, $2)`,
      [result.rows[0].id, creatorId]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      res.status(400).json({ error: 'A group with this name already exists.' });
    } else if (err.code === '23503') {
      res.status(400).json({ error: 'Invalid user session. Please log in again.' });
    } else {
      res.status(500).json({ error: 'Failed to create group. ' + err.message });
    }
  }
});

// Join a study group
router.post('/groups/:id/join', async (req, res) => {
  try {
    const { userId } = req.body;
    await pool.query(
      `INSERT INTO study_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, userId]
    );
    res.json({ success: true, message: 'Joined group successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Leave a study group
router.post('/groups/:id/leave', async (req, res) => {
  try {
    const { userId } = req.body;
    await pool.query(
      `DELETE FROM study_group_members WHERE group_id = $1 AND user_id = $2`,
      [req.params.id, userId]
    );
    res.json({ success: true, message: 'Left group successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Rename a study group (Creator only)
router.patch('/groups/:id/rename', async (req, res) => {
  try {
    const { requesterId, newName } = req.body;
    const groupId = req.params.id;

    if (!newName || !newName.trim()) {
      return res.status(400).json({ error: 'Group name cannot be empty' });
    }

    // Verify requester is the creator
    const groupCheck = await pool.query('SELECT creator_id FROM study_groups WHERE id = $1', [groupId]);
    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    if (Number(groupCheck.rows[0].creator_id) !== Number(requesterId)) {
      return res.status(403).json({ error: 'Only the group creator can rename the group' });
    }

    // Update group name
    const result = await pool.query(
      'UPDATE study_groups SET name = $1 WHERE id = $2 RETURNING *',
      [newName.trim(), groupId]
    );

    res.json({ success: true, message: 'Group renamed successfully', group: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Kick a member (Admin Restricted)
router.post('/groups/:id/kick', async (req, res) => {
  try {
      const { requesterId, targetUserId } = req.body;
      const groupId = req.params.id;

      // 1. Verify Requester is Creator
      const groupCheck = await pool.query('SELECT creator_id FROM study_groups WHERE id = $1', [groupId]);
      if (groupCheck.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
      
      // Strict Check: Intentionally loose equality check (==) for string/int safety or convert?
      // Postgres returns IDs as integers usually, JSON sends strings. Safe to cast.
      if (Number(groupCheck.rows[0].creator_id) !== Number(requesterId)) {
          return res.status(403).json({ error: 'Only the group admin can kick members.' });
      }

      // 2. Perform Kick
      await pool.query(
          `DELETE FROM study_group_members WHERE group_id = $1 AND user_id = $2`,
          [groupId, targetUserId]
      );

      res.json({ success: true, message: 'User kicked successfully' });
  } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
  }
});

// Add Member by Email (Admin Restricted)
router.post('/groups/:id/add-member', async (req, res) => {
  try {
      const { requesterId, emailToAdd } = req.body;
      const groupId = req.params.id;

      if (!emailToAdd || !emailToAdd.trim()) {
         return res.status(400).json({ error: 'Email to add cannot be empty' });
      }

      // 1. Verify Requester is Creator
      const groupCheck = await pool.query('SELECT creator_id FROM study_groups WHERE id = $1', [groupId]);
      if (groupCheck.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
      
      if (Number(groupCheck.rows[0].creator_id) !== Number(requesterId)) {
          return res.status(403).json({ error: 'Only the group admin can add members.' });
      }

      // 2. Find User by Email
      const userCheck = await pool.query('SELECT id FROM users WHERE email = $1', [emailToAdd.trim()]);
      if (userCheck.rows.length === 0) return res.status(404).json({ error: 'User with that email does not exist' });
      const targetUserId = userCheck.rows[0].id;

      // 3. Add to Group
      await pool.query(
          `INSERT INTO study_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [groupId, targetUserId]
      );

      res.json({ success: true, message: 'User added successfully' });
  } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
  }
});

// Delete Group (Creator only)
router.delete('/groups/:id', async (req, res) => {
    try {
        const { requesterId } = req.body;
        const groupId = req.params.id;

        // Verify requester is the creator
        const groupCheck = await pool.query('SELECT creator_id FROM study_groups WHERE id = $1', [groupId]);
        if (groupCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Group not found' });
        }

        if (Number(groupCheck.rows[0].creator_id) !== Number(requesterId)) {
            return res.status(403).json({ error: 'Only the group creator can delete the group' });
        }

        // Delete Members (Manual Cascade for safety)
        await pool.query('DELETE FROM study_group_members WHERE group_id = $1', [groupId]);
        
        // Delete Group
        await pool.query('DELETE FROM study_groups WHERE id = $1', [groupId]);

        res.json({ success: true, message: 'Group deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Get members of a specific group
router.get('/groups/:id/members', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id, u.name, u.email, u.department,
        COALESCE(l.points, 0) as points,
        CASE WHEN u.last_seen > NOW() - INTERVAL '5 minutes' THEN true ELSE false END as is_online,
        sgm.joined_at,
        sgm.is_admin
      FROM study_group_members sgm
      JOIN users u ON sgm.user_id = u.id
      LEFT JOIN leaderboard l ON u.id = l.user_id
      WHERE sgm.group_id = $1
      ORDER BY 
        CASE WHEN u.last_seen > NOW() - INTERVAL '2 minutes' THEN 0 ELSE 1 END,
        l.points DESC NULLS LAST
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============ HELP REQUESTS ============

// Get all open help requests
router.get('/help', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM help_requests 
      WHERE status = 'open' 
      ORDER BY created_at DESC 
      LIMIT 20
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Create a help request
router.post('/help', async (req, res) => {
  try {
    const { userId, userName, subject, message } = req.body;
    const result = await pool.query(
      `INSERT INTO help_requests (user_id, user_name, subject, message) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, userName, subject, message]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============ BROADCASTS ============

// Get recent broadcasts
router.get('/broadcasts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM broadcasts 
      ORDER BY created_at DESC 
      LIMIT 10
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Create a broadcast
router.post('/broadcasts', async (req, res) => {
  try {
    const { userId, userName, message } = req.body;
    const result = await pool.query(
      `INSERT INTO broadcasts (user_id, user_name, message) 
       VALUES ($1, $2, $3) RETURNING *`,
      [userId, userName, message]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============ FIND PARTNERS ============

// Get users available for collaboration (online users who want to study)
router.get('/partners', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id, u.name, u.email, u.department,
        COALESCE(note_counts.verified_count, 0) * 5 as points,
        CASE WHEN u.last_seen > NOW() - INTERVAL '5 minutes' THEN true ELSE false END as is_online
      FROM users u
      LEFT JOIN (
        SELECT uploader_id, COUNT(*) as verified_count 
        FROM notes 
        WHERE verified = true
        GROUP BY uploader_id
      ) note_counts ON u.id = note_counts.uploader_id
      WHERE u.last_seen > NOW() - INTERVAL '2 minutes'
      ORDER BY points DESC NULLS LAST
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============ ALL STUDENTS (For invite picker) ============

router.get('/students', async (req, res) => {
  try {
    const { excludeGroupId } = req.query;
    let query = `
      SELECT u.id, u.name, u.email, u.department,
        CASE WHEN u.last_seen > NOW() - INTERVAL '5 minutes' THEN true ELSE false END as is_online
      FROM users u
    `;
    const params = [];
    if (excludeGroupId) {
      query += ` WHERE u.id NOT IN (SELECT user_id FROM study_group_members WHERE group_id = $1)`;
      params.push(excludeGroupId);
    }
    query += ` ORDER BY u.name ASC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============ GROUP INVITES ============

// Ensure table exists on first use
const ensureInviteTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_invites (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
      inviter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invitee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(group_id, invitee_id)
    )
  `);
};
ensureInviteTable().catch(console.error);

// Send invite(s) — accepts single userId or array of userIds
router.post('/groups/:id/invite', async (req, res) => {
  try {
    const groupId = req.params.id;
    const { requesterId, userIds } = req.body; // userIds: number[]
    if (!userIds || !userIds.length) return res.status(400).json({ error: 'No users specified' });

    const groupCheck = await pool.query('SELECT creator_id FROM study_groups WHERE id = $1', [groupId]);
    if (groupCheck.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    if (Number(groupCheck.rows[0].creator_id) !== Number(requesterId)) {
      return res.status(403).json({ error: 'Only the group admin can invite members.' });
    }

    const results = [];
    for (const uid of userIds) {
      try {
        await pool.query(
          `INSERT INTO group_invites (group_id, inviter_id, invitee_id, status)
           VALUES ($1, $2, $3, 'pending')
           ON CONFLICT (group_id, invitee_id) DO UPDATE SET status = 'pending', created_at = NOW()`,
          [groupId, requesterId, uid]
        );
        results.push({ userId: uid, sent: true });
      } catch (e) {
        results.push({ userId: uid, sent: false, error: e.message });
      }
    }
    res.json({ success: true, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get pending invites for the current logged-in user
router.get('/invites/pending', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const result = await pool.query(`
      SELECT gi.id, gi.group_id, gi.created_at, gi.status,
             sg.name as group_name, sg.subject,
             u.name as inviter_name
      FROM group_invites gi
      JOIN study_groups sg ON gi.group_id = sg.id
      JOIN users u ON gi.inviter_id = u.id
      WHERE gi.invitee_id = $1 AND gi.status = 'pending'
      ORDER BY gi.created_at DESC
    `, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get pending invites for a group (admin view)
router.get('/groups/:id/invites', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT gi.id, gi.invitee_id, gi.status, gi.created_at, u.name as invitee_name, u.email as invitee_email
      FROM group_invites gi
      JOIN users u ON gi.invitee_id = u.id
      WHERE gi.group_id = $1 AND gi.status = 'pending'
      ORDER BY gi.created_at DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Accept an invite
router.post('/invites/:id/accept', async (req, res) => {
  try {
    const { userId } = req.body;
    const invite = await pool.query('SELECT * FROM group_invites WHERE id = $1', [req.params.id]);
    if (invite.rows.length === 0) return res.status(404).json({ error: 'Invite not found' });
    if (Number(invite.rows[0].invitee_id) !== Number(userId)) return res.status(403).json({ error: 'Not your invite' });

    await pool.query('UPDATE group_invites SET status = $1 WHERE id = $2', ['accepted', req.params.id]);
    await pool.query(
      `INSERT INTO study_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [invite.rows[0].group_id, userId]
    );
    res.json({ success: true, groupId: invite.rows[0].group_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Reject an invite
router.post('/invites/:id/reject', async (req, res) => {
  try {
    const { userId } = req.body;
    const invite = await pool.query('SELECT * FROM group_invites WHERE id = $1', [req.params.id]);
    if (invite.rows.length === 0) return res.status(404).json({ error: 'Invite not found' });
    if (Number(invite.rows[0].invitee_id) !== Number(userId)) return res.status(403).json({ error: 'Not your invite' });
    await pool.query('UPDATE group_invites SET status = $1 WHERE id = $2', ['rejected', req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============ GROUP SETTINGS ============

// Update group settings (Creator or Admin only)
router.patch('/groups/:id/settings', async (req, res) => {
  try {
    const groupId = req.params.id;
    const { requesterId, theme_color, avatar_emoji, is_private, allow_member_invites } = req.body;

    // Verify requester is creator OR is_admin
    const groupCheck = await pool.query('SELECT creator_id FROM study_groups WHERE id = $1', [groupId]);
    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const isCreator = Number(groupCheck.rows[0].creator_id) === Number(requesterId);
    if (!isCreator) {
      const adminCheck = await pool.query(
        'SELECT is_admin FROM study_group_members WHERE group_id = $1 AND user_id = $2',
        [groupId, requesterId]
      );
      if (adminCheck.rows.length === 0 || !adminCheck.rows[0].is_admin) {
        return res.status(403).json({ error: 'Only the group creator or an admin can update settings' });
      }
    }

    // Build dynamic update
    const fields = [];
    const values = [];
    let idx = 1;

    if (theme_color !== undefined) { fields.push(`theme_color = $${idx++}`); values.push(theme_color); }
    if (avatar_emoji !== undefined) { fields.push(`avatar_emoji = $${idx++}`); values.push(avatar_emoji); }
    if (is_private !== undefined) { fields.push(`is_private = $${idx++}`); values.push(is_private); }
    if (allow_member_invites !== undefined) { fields.push(`allow_member_invites = $${idx++}`); values.push(allow_member_invites); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No settings provided to update' });
    }

    values.push(groupId);
    const result = await pool.query(
      `UPDATE study_groups SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    res.json({ success: true, group: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============ MEMBER ROLE MANAGEMENT ============

// Promote/demote a member's admin status (Creator only)
router.patch('/groups/:id/members/:userId/role', async (req, res) => {
  try {
    const groupId = req.params.id;
    const targetUserId = req.params.userId;
    const { requesterId, is_admin } = req.body;

    // Only creator can promote/demote admins
    const groupCheck = await pool.query('SELECT creator_id FROM study_groups WHERE id = $1', [groupId]);
    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    if (Number(groupCheck.rows[0].creator_id) !== Number(requesterId)) {
      return res.status(403).json({ error: 'Only the group creator can manage admin roles' });
    }

    await pool.query(
      'UPDATE study_group_members SET is_admin = $1 WHERE group_id = $2 AND user_id = $3',
      [is_admin, groupId, targetUserId]
    );

    res.json({ success: true, message: is_admin ? 'User promoted to admin' : 'User demoted from admin' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============ SHARED LIBRARY (Pinned Notes) ============

// Get shared library for a group
router.get('/groups/:id/library', async (req, res) => {
  try {
    const groupId = req.params.id;
    const result = await pool.query(`
      SELECT gsn.id, gsn.note_id, gsn.pinned_at, gsn.pinned_by,
             n.title, n.subject, n.file_url, n.uploader_id,
             u.name as pinned_by_name
      FROM group_shared_notes gsn
      JOIN notes n ON gsn.note_id = n.id
      LEFT JOIN users u ON gsn.pinned_by = u.id
      WHERE gsn.group_id = $1
      ORDER BY gsn.pinned_at DESC
    `, [groupId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Pin a note to the group library
router.post('/groups/:id/library', async (req, res) => {
  try {
    const groupId = req.params.id;
    const { userId, noteId } = req.body;
    const result = await pool.query(
      `INSERT INTO group_shared_notes (group_id, note_id, pinned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [groupId, noteId, userId]
    );
    res.status(201).json({ success: true, sharedNote: result.rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Unpin a note from the group library
router.delete('/groups/:id/library/:noteId', async (req, res) => {
  try {
    const groupId = req.params.id;
    const noteId = req.params.noteId;
    await pool.query(
      'DELETE FROM group_shared_notes WHERE group_id = $1 AND note_id = $2',
      [groupId, noteId]
    );
    res.json({ success: true, message: 'Note removed from library' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============ GOALS (Collaborative Task Board) ============

// Get all goals for a group
router.get('/groups/:id/goals', async (req, res) => {
  try {
    const groupId = req.params.id;
    const result = await pool.query(`
      SELECT gg.*, u.name as assigned_to_name
      FROM group_goals gg
      LEFT JOIN users u ON gg.assigned_to = u.id
      WHERE gg.group_id = $1
      ORDER BY gg.is_completed ASC, gg.created_at DESC
    `, [groupId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Create a goal
router.post('/groups/:id/goals', async (req, res) => {
  try {
    const groupId = req.params.id;
    const { userId, title, description, assignedTo } = req.body;
    const result = await pool.query(
      `INSERT INTO group_goals (group_id, created_by, title, description, assigned_to)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [groupId, userId, title, description, assignedTo || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Update a goal (toggle completion, reassign, edit)
router.patch('/groups/:id/goals/:goalId', async (req, res) => {
  try {
    const { goalId } = req.params;
    const { is_completed, assigned_to, title, description } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    if (is_completed !== undefined) {
      fields.push(`is_completed = $${idx++}`);
      values.push(is_completed);
      fields.push(`completed_at = $${idx++}`);
      values.push(is_completed ? new Date() : null);
    }
    if (assigned_to !== undefined) { fields.push(`assigned_to = $${idx++}`); values.push(assigned_to); }
    if (title !== undefined) { fields.push(`title = $${idx++}`); values.push(title); }
    if (description !== undefined) { fields.push(`description = $${idx++}`); values.push(description); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields provided to update' });
    }

    values.push(goalId);
    const result = await pool.query(
      `UPDATE group_goals SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Goal not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a goal
router.delete('/groups/:id/goals/:goalId', async (req, res) => {
  try {
    const { goalId } = req.params;
    await pool.query('DELETE FROM group_goals WHERE id = $1', [goalId]);
    res.json({ success: true, message: 'Goal deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============ MEETS (Event Scheduler) ============

// Get upcoming meets for a group
router.get('/groups/:id/meets', async (req, res) => {
  try {
    const groupId = req.params.id;
    const result = await pool.query(`
      SELECT gm.*, u.name as creator_name
      FROM group_meets gm
      LEFT JOIN users u ON gm.created_by = u.id
      WHERE gm.group_id = $1 AND gm.scheduled_at >= NOW()
      ORDER BY gm.scheduled_at ASC
    `, [groupId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Create a meet
router.post('/groups/:id/meets', async (req, res) => {
  try {
    const groupId = req.params.id;
    const { userId, title, description, scheduledAt, durationMinutes, meetType } = req.body;
    const result = await pool.query(
      `INSERT INTO group_meets (group_id, created_by, title, description, scheduled_at, duration_minutes, meet_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [groupId, userId, title, description, scheduledAt, durationMinutes || 60, meetType || 'study']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a meet
router.delete('/groups/:id/meets/:meetId', async (req, res) => {
  try {
    const { meetId } = req.params;
    await pool.query('DELETE FROM group_meets WHERE id = $1', [meetId]);
    res.json({ success: true, message: 'Meet deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
