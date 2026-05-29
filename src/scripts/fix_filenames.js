const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const pool = require('../db');

async function fixCorruptedFilenames() {
    console.log("🚑 Restoring corrupted filenames...");
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        
        // Restore ID 31
        await client.query(
            "UPDATE notes SET file_name = $1, file_url = NULL WHERE id = 31",
            ['1767975306127-Final Report.pdf']
        );
        console.log("✅ Restored ID 31");

        // Restore ID 34
        await client.query(
            "UPDATE notes SET file_name = $1, file_url = NULL WHERE id = 34",
            ['1768016457905-Final Report.pdf']
        );
        console.log("✅ Restored ID 34");

        await client.query("COMMIT");
    } catch (e) {
        await client.query("ROLLBACK");
        console.error(e);
    } finally {
        client.release();
        pool.end();
    }
}
fixCorruptedFilenames();
