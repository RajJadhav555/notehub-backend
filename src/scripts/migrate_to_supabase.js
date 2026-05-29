const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const pool = require('../db');

// Configure Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const BUCKET_NAME = 'notehub-uploads';

const uploadsDir = path.join(__dirname, '../../uploads');

async function migrateToSupabase() {
    console.log("🚀 Starting migration of local notes to Supabase...");
    
    if (!supabaseUrl || !supabaseKey) {
        console.error("❌ Supabase credentials not found!");
        process.exit(1);
    }

    const client = await pool.connect();

    try {
        // Fetch all notes that are NOT on Supabase yet
        const res = await client.query(
            "SELECT * FROM notes WHERE file_url NOT LIKE '%supabase.co%' AND file_name IS NOT NULL"
        );

        const notesToMigrate = res.rows;
        console.log(`📋 Found ${notesToMigrate.length} notes (potentially local) to migrate.`);

        for (const note of notesToMigrate) {
            // DB might have 'notehub_migration/filename.pdf' or 'filename.pdf.undefined'
            // We need to resolve to the flat structure in backend/uploads/
            const cleanFileName = path.basename(note.file_name).replace('.undefined', '');
            const localFilePath = path.join(uploadsDir, cleanFileName);

            console.log(`\nProcessing Note ID ${note.id}: ${note.title}`);
            console.log(`   📂 Looking for local file: ${cleanFileName}`);
            
            if (fs.existsSync(localFilePath)) {
                try {
                    const fileBuffer = fs.readFileSync(localFilePath);
                    const fileMime = note.file_type === 'PDF' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                    
                    // Use clean filename as storage path
                    const storagePath = cleanFileName;

                    console.log(`   ⬆️ Uploading to Supabase bucket '${BUCKET_NAME}'...`);
                    
                    const { data, error } = await supabase.storage
                        .from(BUCKET_NAME)
                        .upload(storagePath, fileBuffer, {
                            contentType: fileMime,
                            upsert: true 
                        });

                    if (error) throw error;

                    // Get Public URL
                    const { data: urlData } = supabase.storage
                        .from(BUCKET_NAME)
                        .getPublicUrl(storagePath);
                    
                    const newUrl = urlData.publicUrl;
                    console.log(`   ✅ Uploaded! URL: ${newUrl}`);

                    // Update Database (preserve original filename if needed, or update to clean one)
                    // Let's update file_name to the clean path relative to bucket root
                    await client.query(
                        "UPDATE notes SET file_url = $1, file_name = $2 WHERE id = $3",
                        [newUrl, storagePath, note.id]
                    );
                    
                    console.log(`   💾 Database updated.`);

                } catch (err) {
                    console.error(`   ❌ Failed to upload/update:`, err.message);
                }
            } else {
                console.warn(`   ⚠️ Local file not found at: ${localFilePath}`);
            }
        }

        console.log("\n✅ Migration process completed.");

    } catch (err) {
        console.error("❌ Fatal migration error:", err);
    } finally {
        client.release();
        pool.end();
    }
}

migrateToSupabase();
