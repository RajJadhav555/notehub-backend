const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
const { Pool } = require('pg');

const poolConfig = {
    user: process.env.POSTGRES_USER,
    host: process.env.DB_HOST,
    database: process.env.POSTGRES_DB,
    password: process.env.POSTGRES_PASSWORD,
    port: process.env.DB_PORT,
};

console.log("Testing connection with:", {
    ...poolConfig,
    password: '****',
    ssl: false
});

const pool = new Pool({
    ...poolConfig,
    ssl: false
});

pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error("❌ Connection Failed:", err);
    } else {
        console.log("✅ Connection Successful!", res.rows[0]);
    }
    pool.end();
});
