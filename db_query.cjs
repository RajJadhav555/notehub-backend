const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/notehub' });
pool.query("SELECT * FROM notes WHERE title = 'Data Structures - Complete Notes'")
  .then(res => console.log(res.rows[0]))
  .catch(console.error)
  .finally(() => pool.end());
