const pool = require('../db');

async function resetData() {
    const client = await pool.connect();
    try {
        console.log("🗑️ Deleting all notes...");
        await client.query("DELETE FROM notes");
        
        console.log("🔄 Resetting leaderboard stats...");
        await client.query("UPDATE leaderboard SET points = 0, uploads = 0, verified_notes = 0");
        
        console.log("✅ Data reset complete.");
    } catch (e) {
        console.error("❌ Error resetting data:", e);
    } finally {
        client.release();
        process.exit();
    }
}

resetData();
