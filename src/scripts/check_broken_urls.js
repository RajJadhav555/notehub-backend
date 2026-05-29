const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const pool = require('../db');

async function checkBrokenUrls() {
    console.log("🔍 Checking for broken URLs...");
    const client = await pool.connect();
    try {
        const res = await client.query(
            "SELECT id, title, file_url FROM notes WHERE file_url IS NULL OR file_url = 'undefined' OR file_url = ''"
        );
        
        if (res.rows.length === 0) {
            console.log("✅ No broken URLs found (checking 'undefined' string literal too).");
        } else {
            console.log(`⚠️  ${res.rows.length} notes have broken URLs:`);
            console.table(res.rows);
        }
    } catch (e) {
        console.error(e);
    } finally {
        client.release();
        pool.end();
    }
}
checkBrokenUrls();
