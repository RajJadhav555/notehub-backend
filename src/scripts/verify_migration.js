const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const pool = require('../db');

async function checkRemaining() {
    console.log("🔍 Checking for non-migrated notes...");
    const client = await pool.connect();
    try {
        const res = await client.query(
            "SELECT id, title, file_name, file_url FROM notes WHERE file_url NOT LIKE '%cloudinary.com%' AND file_name IS NOT NULL"
        );
        
        if (res.rows.length === 0) {
            console.log("✅ All notes appear to be migrated!");
        } else {
            console.log(`⚠️  ${res.rows.length} notes still need migration:`);
            console.table(res.rows);
        }
    } catch (e) {
        console.error(e);
    } finally {
        client.release();
        pool.end();
    }
}
checkRemaining();
