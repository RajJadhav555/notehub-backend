const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const pool = require('../db');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const uploadsDir = path.join(__dirname, '../../uploads');

async function migrateNotes() {
    console.log("🚀 Starting migration of local notes to Cloudinary...");
    
    if (!process.env.CLOUDINARY_CLOUD_NAME) {
        console.error("❌ Cloudinary credentials not found in environment!");
        process.exit(1);
    }

    const client = await pool.connect();

    try {
        // Heuristic: file_url does not contain 'cloudinary.com' OR is NULL
        const res = await client.query(
            "SELECT * FROM notes WHERE (file_url NOT LIKE '%cloudinary.com%' OR file_url IS NULL) AND file_name IS NOT NULL"
        );

        const notesToMigrate = res.rows;
        console.log(`📋 Found ${notesToMigrate.length} notes to migrate.`);

        let successCount = 0;
        let failCount = 0;
        let missingFileCount = 0;

        for (const note of notesToMigrate) {
            const localFilePath = path.join(uploadsDir, note.file_name);

            console.log(`\nProcessing Note ID ${note.id}: ${note.title} (File: ${note.file_name})`);

            if (fs.existsSync(localFilePath)) {
                try {
                    let uploadResult;
                    const stats = fs.statSync(localFilePath);
                    const fileSizeInBytes = stats.size;
                    const isLargeFile = fileSizeInBytes > 10000000; // > 10MB

                    if (isLargeFile) {
                         console.log(`   ⚠️ Large file detected (${(fileSizeInBytes / 1024 / 1024).toFixed(2)} MB). Using chunked upload...`);
                         uploadResult = await cloudinary.uploader.upload_large(localFilePath, {
                            resource_type: "auto",
                            public_id: note.file_name.split('.')[0].trim(),
                            folder: "notehub_migration",
                            chunk_size: 6000000 // 6MB chunks
                        });
                    } else {
                        uploadResult = await cloudinary.uploader.upload(localFilePath, {
                            resource_type: "auto",
                            public_id: note.file_name.split('.')[0].trim(),
                            folder: "notehub_migration"
                        });
                    }

                    console.log("   🔍 Full Upload Result:", JSON.stringify(uploadResult, null, 2));
                    console.log(`   ✅ Uploaded! URL: ${uploadResult ? uploadResult.secure_url : 'UNDEFINED'}`);

                    // Update Database
                    const newFileName = uploadResult.public_id + "." + uploadResult.format;
                    await client.query(
                        "UPDATE notes SET file_url = $1, file_name = $2 WHERE id = $3",
                        [uploadResult.secure_url, newFileName, note.id]
                    );
                    
                    console.log(`   💾 Database updated.`);
                    successCount++;

                } catch (err) {
                    console.error(`   ❌ Failed to upload/update:`, err.message);
                    failCount++;
                }
            } else {
                console.warn(`   ⚠️ Local file not found at: ${localFilePath}`);
                missingFileCount++;
            }
        }

        console.log("\n===========================================");
        console.log("Migration Summary");
        console.log("===========================================");
        console.log(`Total Found:    ${notesToMigrate.length}`);
        console.log(`Success:        ${successCount}`);
        console.log(`Failed:         ${failCount}`);
        console.log(`Missing Files:  ${missingFileCount}`);
        console.log("===========================================");

    } catch (err) {
        console.error("❌ Fatal migration error:", err);
    } finally {
        client.release();
        pool.end(); // Close the pool to exit script
    }
}

migrateNotes();
