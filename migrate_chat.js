const pool = require('./src/db');
async function run() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bot_type VARCHAR(50) NOT NULL,
        role VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_history_user_id ON chat_history(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_history_bot_type ON chat_history(bot_type);`);
    console.log('Table created successfully');
  } catch (e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
run();
