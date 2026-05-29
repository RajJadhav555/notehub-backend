const { Pool } = require('pg');

const combos = [
  { user: 'notehub_user', pass: 'notehub_password_123', db: 'notehub_database' },
  { user: 'postgres', pass: 'postgres', db: 'postgres' },
  { user: 'postgres', pass: 'password', db: 'postgres' },
  { user: 'postgres', pass: 'notehub_password_123', db: 'notehub_database' }
];

async function check() {
  console.log("🔍 Testing Database Credentials...\n");
  
  for (const c of combos) {
    const pool = new Pool({
      user: c.user,
      host: 'localhost',
      database: c.db,
      password: c.pass,
      port: 5432,
      connectionTimeoutMillis: 2000
    });

    try {
      await pool.query('SELECT 1');
      console.log(`✅ SUCCESS! User: ${c.user}, Pass: ${c.pass}, DB: ${c.db}`);
      await pool.end();
      return; 
    } catch (err) {
      process.stdout.write(`❌ Failed (${c.user}/${c.pass}/${c.db}): `);
       if (err.code === '28P01') console.log("Auth Failed");
       else if (err.code === '3D000') console.log("DB Does Not Exist");
       else if (err.code === 'ECONNREFUSED') console.log("Connection Refused (No DB running)");
       else console.log(err.message);
    } finally {
        await pool.end(); // Silence warnings
    }
  }
  console.log("\n❌ No working credentials found.");
}

check();
