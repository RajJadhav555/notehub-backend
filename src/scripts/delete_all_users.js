const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const pool = require('../db');

async function deleteAllUsers() {
  try {
    console.log('🗑️ Deleting ALL users...');
    // Using TRUNCATE with CASCADE to clean up related data (messages, leaderboard, etc.) clearly
    const result = await pool.query("TRUNCATE TABLE users CASCADE");
    console.log(`✅ All users deleted successfully.`);
  } catch (err) {
    console.error('❌ Error deleting users:', err);
  } finally {
    await pool.end();
  }
}

deleteAllUsers();
