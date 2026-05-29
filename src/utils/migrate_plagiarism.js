/**
 * Migration v2: Create note_shingles table if it doesn't exist,
 * then ensure all required columns are present.
 * Run once: node src/utils/migrate_plagiarism.js
 */
const pool = require('../db');

async function migrate() {
    try {
        // Create table if not exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS note_shingles (
                id SERIAL PRIMARY KEY,
                note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                shingle_hashes TEXT,
                text_length INTEGER,
                winnow_fingerprints TEXT DEFAULT NULL,
                sentence_hashes TEXT DEFAULT NULL,
                paragraph_fingerprints TEXT DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(note_id)
            )
        `);

        // Ensure columns exist (safe for re-runs)
        await pool.query(`ALTER TABLE note_shingles ADD COLUMN IF NOT EXISTS winnow_fingerprints TEXT DEFAULT NULL`);
        await pool.query(`ALTER TABLE note_shingles ADD COLUMN IF NOT EXISTS sentence_hashes TEXT DEFAULT NULL`);
        await pool.query(`ALTER TABLE note_shingles ADD COLUMN IF NOT EXISTS paragraph_fingerprints TEXT DEFAULT NULL`);

        // ✅ FIX #19: Ensure note_embeddings has ON DELETE CASCADE
        // Without this, deleted notes leave phantom embeddings that inflate semantic similarity
        try {
            // Check if note_embeddings table exists
            const tableCheck = await pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'note_embeddings'
                )
            `);
            
            if (tableCheck.rows[0].exists) {
                // Check if FK constraint has ON DELETE CASCADE
                const fkCheck = await pool.query(`
                    SELECT confdeltype FROM pg_constraint 
                    WHERE conname LIKE '%note_embeddings%note_id%' 
                    OR (conrelid = 'note_embeddings'::regclass AND contype = 'f')
                `);
                
                const needsCascade = fkCheck.rows.length === 0 || 
                    fkCheck.rows.some(r => r.confdeltype !== 'c'); // 'c' = CASCADE
                
                if (needsCascade) {
                    console.log('🔧 Fixing note_embeddings FK to add ON DELETE CASCADE...');
                    // Drop existing FK if any, then re-add with CASCADE
                    await pool.query(`
                        DO $$
                        DECLARE
                            fk_name TEXT;
                        BEGIN
                            SELECT conname INTO fk_name 
                            FROM pg_constraint 
                            WHERE conrelid = 'note_embeddings'::regclass AND contype = 'f'
                            LIMIT 1;
                            
                            IF fk_name IS NOT NULL THEN
                                EXECUTE 'ALTER TABLE note_embeddings DROP CONSTRAINT ' || fk_name;
                            END IF;
                            
                            ALTER TABLE note_embeddings 
                                ADD CONSTRAINT note_embeddings_note_id_fkey 
                                FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE;
                        END $$;
                    `);
                    console.log('✅ note_embeddings FK now has ON DELETE CASCADE');
                } else {
                    console.log('✅ note_embeddings FK already has ON DELETE CASCADE');
                }
            }
        } catch (embErr) {
            console.warn('⚠️ Could not verify note_embeddings CASCADE:', embErr.message);
        }

        console.log('✅ Migration v3: note_shingles + note_embeddings CASCADE ensured');
    } catch (e) {
        console.error('Migration error:', e.message);
    } finally {
        await pool.end();
    }
}

migrate();
