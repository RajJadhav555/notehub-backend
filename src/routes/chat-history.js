const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET /api/chat-history/:botType
// Fetch chat history for a specific bot type
router.get('/:botType', async (req, res) => {
  try {
    const userId = req.user.id;
    const { botType } = req.params;

    const result = await pool.query(
      'SELECT role, content, created_at FROM chat_history WHERE user_id = $1 AND bot_type = $2 ORDER BY created_at ASC',
      [userId, botType]
    );

    res.json({ history: result.rows });
  } catch (err) {
    console.error('Error fetching chat history:', err);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

// GET /api/chat-history/recent/all
// Fetch latest chat snippets for profile page
router.get('/recent/all', async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get the latest message for each bot_type
    const result = await pool.query(`
      SELECT DISTINCT ON (bot_type)
        bot_type,
        role,
        content,
        created_at
      FROM chat_history
      WHERE user_id = $1
      ORDER BY bot_type, created_at DESC
    `, [userId]);

    res.json({ recent: result.rows });
  } catch (err) {
    console.error('Error fetching recent chats:', err);
    res.status(500).json({ error: 'Failed to fetch recent chats' });
  }
});

// DELETE /api/chat-history/:botType
// Clear chat history for a specific bot type
router.delete('/:botType', async (req, res) => {
  try {
    const userId = req.user.id;
    const { botType } = req.params;

    await pool.query(
      'DELETE FROM chat_history WHERE user_id = $1 AND bot_type = $2',
      [userId, botType]
    );

    res.json({ success: true, message: 'Chat history cleared' });
  } catch (err) {
    console.error('Error clearing chat history:', err);
    res.status(500).json({ error: 'Failed to clear chat history' });
  }
});

module.exports = router;
