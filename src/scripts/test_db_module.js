const pool = require('../db');

async function testDbModule() {
  try {
    console.log("🔍 Testing db.js module...");
    const res = await pool.query('SELECT NOW()');
    console.log("✅ Database connection successful via db.js!");
    console.log("Time:", res.rows[0].now);
    
    console.log("\n🔍 Checking Users Table via module...");
    const userRes = await pool.query("SELECT * FROM users LIMIT 1");
    console.log(`✅ Users Table Accessible. Count: ${userRes.rowCount}`);
    
  } catch (err) {
    console.error("❌ db.js module failed:", err);
  } finally {
    pool.end();
  }
}

testDbModule();
