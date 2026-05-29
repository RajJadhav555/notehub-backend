const pool = require('../db');

async function checkNotes() {
    try {
        const res = await pool.query("SELECT id, title, file_name, file_type FROM notes");
        console.table(res.rows);
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}

checkNotes();
