-- Migration: Add AI Verification columns to notes table
-- Run this SQL script on your PostgreSQL database

-- Add verification status column
ALTER TABLE notes 
ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) DEFAULT 'pending';

-- Add AI verification score column
ALTER TABLE notes 
ADD COLUMN IF NOT EXISTS ai_verification_score INTEGER DEFAULT 0;

-- Add verification details column (stores JSON)
ALTER TABLE notes 
ADD COLUMN IF NOT EXISTS verification_details JSONB;

-- Add verified_at timestamp
ALTER TABLE notes 
ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;

-- Add verified_by column (to track if AI or admin verified)
ALTER TABLE notes 
ADD COLUMN IF NOT EXISTS verified_by VARCHAR(50) DEFAULT 'ai_system';

-- Create index for faster queries on verification status
CREATE INDEX IF NOT EXISTS idx_notes_verification_status ON notes(verification_status);

-- Update existing notes to have default verification status
UPDATE notes 
SET verification_status = CASE 
    WHEN verified = true THEN 'auto_approved'
    ELSE 'manual_review'
END
WHERE verification_status IS NULL OR verification_status = 'pending';

-- Add comment for documentation
COMMENT ON COLUMN notes.verification_status IS 'AI verification status: pending, auto_approved, manual_review, rejected';
COMMENT ON COLUMN notes.ai_verification_score IS 'AI verification score from 0-100';
COMMENT ON COLUMN notes.verification_details IS 'JSON object containing detailed verification results from AI';

SELECT 'Migration completed successfully!' AS status;
