const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const pool = require('../db');

async function checkUsers() {
  try {
    console.log('🔍 Checking users in database...');
    const result = await pool.query('SELECT id, name, email, created_at FROM users ORDER BY created_at DESC');
    
    if (result.rows.length === 0) {
      console.log('❌ No users found in the database.');
    } else {
      console.log(`✅ Found ${result.rows.length} users:`);
      result.rows.forEach(u => {
        console.log(`- ID: ${u.id} | Name: ${u.name} | Email: ${u.email} | Created: ${u.created_at}`);
      });
    }
  } catch (err) {
    console.error('❌ Error querying users:', err);
  } finally {
    await pool.end();
  }
}

checkUsers();
