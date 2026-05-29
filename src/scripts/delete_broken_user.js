const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const pool = require('../db');

async function deleteBrokenUser() {
  try {
    const email = 'tusharsk3412@gmail.com';
    console.log(`🗑️ Deleting broken user: ${email}...`);
    const result = await pool.query("DELETE FROM users WHERE email = $1", [email]);
    console.log(`✅ Deleted ${result.rowCount} user(s).`);
  } catch (err) {
    console.error('❌ Error deleting user:', err);
  } finally {
    await pool.end();
  }
}

deleteBrokenUser();
