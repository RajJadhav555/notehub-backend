const express = require('express');
const pool = require('../db');

const router = express.Router();

// Get messages from a group
router.get('/group/:groupName', async (req, res) => {
  try {
    const { groupName } = req.params;
    const result = await pool.query(
      'SELECT * FROM messages WHERE group_name = $1 ORDER BY created_at DESC LIMIT 100',
      [groupName]
    );
    res.json(result.rows.reverse());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Send message (POST /)
router.post('/', async (req, res) => {
  try {
    const { userId, userName, message, groupName = 'General' } = req.body;
    const result = await pool.query(
      `INSERT INTO messages (user_id, user_name, message, group_name) 
       VALUES ($1, $2, $3, $4) 
       RETURNING *`,
      [userId, userName, message, groupName]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Send message
router.post('/send', async (req, res) => {
  try {
    const { userId, userName, message, groupName = 'General' } = req.body;
    const result = await pool.query(
      `INSERT INTO messages (user_id, user_name, message, group_name) 
       VALUES ($1, $2, $3, $4) 
       RETURNING *`,
      [userId, userName, message, groupName]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get all groups
router.get('/groups', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT DISTINCT group_name FROM messages ORDER BY group_name'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
