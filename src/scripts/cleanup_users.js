const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function cleanupTestUsers() {
  try {
    const result = await pool.query(
      "DELETE FROM users WHERE email LIKE '%@notehub.com'"
    );
    console.log('Deleted', result.rowCount, 'test users with @notehub.com emails');
    
    // Show remaining users
    const remaining = await pool.query('SELECT id, name, email FROM users ORDER BY id');
    console.log('\nRemaining authentic users:');
    remaining.rows.forEach(u => console.log('-', u.name, '|', u.email));
    
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

cleanupTestUsers();
