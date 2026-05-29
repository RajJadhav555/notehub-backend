const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') }); // Load from root (Notehub/.env)

const pool = new Pool({
  user: process.env.POSTGRES_USER || 'notehub_user',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.POSTGRES_DB || 'notehub_database',
  password: process.env.POSTGRES_PASSWORD || 'notehub_password_123',
  port: process.env.DB_PORT || 5432,
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log("🔄 Starting Vector Migration (1024 -> 1536)...");
    
    await client.query('BEGIN');

    // 1. Enable vector extension (just in case)
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    // 2. Check if table exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'note_embeddings'
      );
    `);

    if (tableCheck.rows[0].exists) {
        console.log("🗑️ Dropping existing note_embeddings table (incompatible dimensions)...");
        await client.query('DROP TABLE note_embeddings');
    }

    // 3. Create new table with 1536 dimensions
    console.log("✨ Creating new note_embeddings table with vector(1536)...");
    await client.query(`
      CREATE TABLE note_embeddings (
        id SERIAL PRIMARY KEY,
        note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
        chunk_index INTEGER,
        content TEXT,
        embedding vector(1536),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // 4. Create index for fast search
    // await client.query(`CREATE INDEX ON note_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);`);
    // Note: ivfflat needs data to be effective, usually created after loading data. 
    // We can stick to basic HNSW if supported or just no index for now until data is populated.
    // Let's create a basic HNSW index if pgvector enables it, or just leave it for now.
    // HNSW is safer:
    // await client.query(`CREATE INDEX ON note_embeddings USING hnsw (embedding vector_cosine_ops);`);
    
    await client.query('COMMIT');
    console.log("✅ Migration Successful! Table ready for OpenAI embeddings.");
    console.log("⚠️ NOTE: You must RE-INDEX existing notes (`/api/notes/reindex`) to repopulate search.");

  } catch (e) {
    await client.query('ROLLBACK');
    console.error("❌ Migration Failed:", e);
  } finally {
    client.release();
    pool.end();
  }
}

migrate();
