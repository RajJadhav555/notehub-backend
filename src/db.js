const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      user: process.env.POSTGRES_USER || 'notehub_user',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.POSTGRES_DB || 'notehub_database',
      password: process.env.POSTGRES_PASSWORD || 'notehub_password_123',
      port: process.env.DB_PORT || 5432,
    };

const pool = new Pool({
  ...poolConfig,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: false,
  application_name: 'notehub-backend'
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle client:', err);
});

pool.on('connect', (client) => {
  console.log('✅ New client connected to database');
});

// Test the connection
pool.query('SELECT NOW()', (err, result) => {
  if (err) {
    console.error('❌ Failed to connect to database:', err);
  } else {
    console.log('✅ Database connection successful. Server time:', result.rows[0].now);
  }
});

module.exports = pool;
