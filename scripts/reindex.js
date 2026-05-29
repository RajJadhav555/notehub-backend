const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Import RAG utilities
// Note: adjusting paths relative to scripts/ folder
const { extractText, chunkText, storeEmbeddings } = require('../src/utils/rag');
const pool = require('../src/db');

const uploadsDir = path.join(__dirname, "../../uploads");

async function reindexAll() {
    console.log("🔄 Starting Full Re-indexing (OpenAI Embeddings)...");
    
    const client = await pool.connect();
    
    try {
        // 1. Fetch all notes
        const allNotes = await client.query("SELECT * FROM notes");
        console.log(`Found ${allNotes.rows.length} total notes to check.`);
        
        let processed = 0;
        let skipped = 0;
        let errors = 0;

        // Process sequentially
        for (const note of allNotes.rows) {
            try {
                let buffer;
                
                // Try Local File
                if (note.file_name) {
                    const localPath = path.join(uploadsDir, note.file_name);
                    if (fs.existsSync(localPath)) {
                        buffer = fs.readFileSync(localPath);
                    } 
                }
                
                // Try Cloud URL if local failed
                if (!buffer && note.file_url) {
                    try {
                        console.log(`☁️ Fetching from URL for note ${note.id}...`);
                        const resp = await fetch(note.file_url);
                        if (resp.ok) buffer = Buffer.from(await resp.arrayBuffer());
                    } catch (e) {
                         console.error(`Failed to fetch file for note ${note.id}:`, e.message);
                    }
                }

                if (buffer) {
                     // Determine mime type (approximate)
                     const mimeType = note.file_type === 'DOCX' 
                        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' 
                        : 'application/pdf';

                     const text = await extractText(buffer, mimeType);
                     
                     if (text && text.length > 50) {
                         const chunks = chunkText(text);
                         
                         // Store embeddings (this will delete old ones first)
                         await storeEmbeddings(note.id, chunks);
                         
                         processed++;
                         console.log(`✅ Re-indexed note ${note.id} (${chunks.length} chunks)`);
                     } else {
                         skipped++;
                         console.warn(`⚠️ No text extracted for note ${note.id}`);
                     }
                } else {
                    skipped++;
                    console.warn(`⚠️ Could not locate file content for note ${note.id}`);
                }
            } catch (err) {
                errors++;
                console.error(`❌ Error re-indexing note ${note.id}:`, err.message);
            }
        }

        console.log(`\n🎉 Re-indexing Complete!`);
        console.log(`Processed: ${processed}`);
        console.log(`Skipped: ${skipped}`);
        console.log(`Errors: ${errors}`);

    } catch (err) {
        console.error("Re-index Fatal Error:", err);
    } finally {
        client.release();
        await pool.end();
    }
}

reindexAll();
