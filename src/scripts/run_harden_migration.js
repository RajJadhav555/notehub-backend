const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const pool = require('../db');

async function runHardening() {
  console.log("🚀 Running Database Schema Hardening for ID Verification...");
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS id_card_hash VARCHAR(255) UNIQUE;
    `);
    console.log("✅ Added id_card_hash UNIQUE column constraint");

    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS verified_name VARCHAR(255) UNIQUE;
    `);
    console.log("✅ Added verified_name UNIQUE column constraint");

    console.log("🎉 Migration completed securely!");
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
  } finally {
    client.release();
    pool.end();
  }
}

runHardening();
