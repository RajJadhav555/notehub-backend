const pool = require('../db');

async function checkVector() {
  try {
    console.log('Checking for pgvector extension...');
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    console.log('✅ pgvector extension is available and enabled!');
    
    // Check if we can create a table with vector column
    await pool.query(`
      CREATE TABLE IF NOT EXISTS test_embeddings (
        id SERIAL PRIMARY KEY,
        embedding vector(768)
      );
    `);
    console.log('✅ Could create table with vector column.');
    
    // Clean up
    await pool.query('DROP TABLE IF EXISTS test_embeddings');
    console.log('✅ Cleanup successful.');

  } catch (err) {
    console.error('❌ pgvector check failed:', err.message);
    if (err.message.includes('could not open extension control file')) {
        console.log('Hint: The PostgreSQL instance might not have pgvector installed.');
    }
  } finally {
    pool.end();
  }
}

checkVector();
