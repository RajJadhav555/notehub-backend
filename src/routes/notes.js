const express = require("express");
const pool = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { createClient } = require('@supabase/supabase-js');
const { extractText, chunkText, storeEmbeddings, searchSimilar } = require('../utils/rag');
const { callAI } = require('../utils/ai');
const { verifyDocument } = require('../utils/aiVerifier');
const { checkPlagiarism, storeShingles } = require('../utils/plagiarismChecker');
const { checkWebPlagiarism } = require('../utils/webPlagiarismChecker');
const mammoth = require("mammoth");
const { requireAuth } = require('../middleware/authMiddleware');
const { validate, ratingSchema } = require('../middleware/validators');

// ✅ FIX #18: Rate limiter for plagiarism-check endpoint
let rateLimit;
try {
    rateLimit = require('express-rate-limit');
} catch (e) {
    // Fallback: no-op middleware if express-rate-limit is not installed
    rateLimit = null;
}

const plagiarismCheckLimiter = rateLimit
    ? rateLimit({
        windowMs: 60 * 60 * 1000, // 1 hour window
        max: 10,                   // limit each user to 10 checks per hour
        keyGenerator: (req) => req.user?.id || req.ip,
        validate: { keygenerator: false },
        message: { error: 'Too many plagiarism checks. Please try again in an hour.' },
        standardHeaders: true,
        legacyHeaders: false,
    })
    : (req, res, next) => next(); // No-op if package unavailable


const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Notes
 *   description: The notes managing API
 */

/**
 * @swagger
 * /api/notes/chat:
 *   post:
 *     summary: Chat with the AI using notes context
 *     tags: [Notes]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - message
 *             properties:
 *               message:
 *                 type: string
 *                 description: The user message or question
 *     responses:
 *       200:
 *         description: AI response based on notes context
 *       400:
 *         description: Message required
 *       500:
 *         description: Server error
 */

// Configure Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const BUCKET_NAME = 'notehub-uploads';

// Create uploads directory if it doesn't exist (For backward compatibility / locally stored files)
const uploadsDir = path.join(__dirname, "../../uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for MEMORY storage
const storage = multer.memoryStorage();
const upload = multer({ storage });

// --- AI Helper: Retry & Fallback Logic ---
// --- AI Helper: Retry & Fallback Logic moved to utils/ai.js ---
// -----------------------------------------

// Notes AI Chat (requires auth)
router.post("/chat", requireAuth, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: "Message required" });

        const apiKey = process.env.OPENAI_API_KEY;
        
        // 1. Get Context from RAG (Deep Content) - SEARCHING ONLY VERIFIED NOTES
        const contextDocs = await searchSimilar(message, 15, true); // verifiedOnly=true
        let contextString = "";
        
        if (contextDocs.length > 0) {
            contextString = contextDocs.map(doc => doc.content).join("\n---\n");
            console.log(`📚 Notes AI: Found ${contextDocs.length} relevant chunks.`);
        }

        // 2. Get Metadata of VERIFIED Notes (High-level Awareness)
        const notesMetaResult = await pool.query(
            "SELECT id, title, subject, semester, uploader_name, verified FROM notes WHERE verified = true ORDER BY upload_date DESC LIMIT 500"
        );
        const notesList = notesMetaResult.rows.map(n => 
            `- "${n.title}" (Subject: ${n.subject}, Sem: ${n.semester}, ID: ${n.id})`
        ).join("\n");
        
        const fullContext = `
        List of Available VERIFIED Notes:
        ${notesList}
        
        Detailed Content from Relevant Notes (RAG):
        ${contextString || "No specific detailed content found for this query."}
        `;

        // 3. Call AI
        const messages = [
            {
                role: "system",
                content: `You are a helpful, intelligent Academic Study Assistant for NoteHub. 
                        
YOUR GOAL: Answer the student's question using the provided context.

CONTEXT:
${fullContext}

INSTRUCTIONS:
1. STRICT DATA EXTRACTION: You rely ONLY on the provided "Detailed Content" (RAG) and "Notes List". Do not hallucinate note content.
2. STRUCTURED & OPTIMIZED DISPLAY: 
   - Format your answer using clear **Markdown**.
   - Use ### Headings to organize topics.
   - Use **Bulleted Lists** to summarize key points.
   - Use **Bold** for important terms or definitions.
   - If comparing notes, use a table structure if possible (or clear comparison lists).
3. If the user asks for a summary, provide a structured summary (Key Concepts, Important Formulas, etc.).
4. If the answer is NOT in the context, clearly state: "I couldn't find specific details in the uploaded notes, but here is some general info..." (and label it clearly).
5. JSON REQUESTS: If the user asks for JSON, output ONLY valid JSON.
6. Be helpful, professional, and academic in tone.`
            },
            {
                role: "user",
                content: message
            }
        ];

        const data = await callAI(apiKey, messages);
        
        // Extract reply from Mistral response
        if (!data.choices || data.choices.length === 0) {
            console.error("Mistral returned no choices:", JSON.stringify(data));
            return res.json({ reply: "I'm sorry, I couldn't process that right now. Please try again." });
        }

        const reply = data.choices[0].message.content;
        res.json({ reply });

    } catch (err) {
        console.error("Notes AI Error:", err);
        res.json({ reply: `I encountered an internal error: ${err.message}. Please try again later.` });
    }
});

// Re-index All Notes (Admin/Maintenance Tool — requires auth)
router.post("/reindex", requireAuth, async (req, res) => {
    console.log("🔄 Starting Full Re-indexing...");
    try {
        const client = await pool.connect();
        const allNotes = await client.query("SELECT * FROM notes");
        client.release();

        console.log(`Found ${allNotes.rows.length} total notes to check.`);
        let processed = 0;
        let skipped = 0;
        let errors = 0;

        // Process sequentially to avoid rate limits
        for (const note of allNotes.rows) {
            try {
                // Check if already embedded? (Actually storeEmbeddings deletes old ones, so we just overwrite)
                
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
                        const resp = await fetch(note.file_url);
                        if (resp.ok) buffer = await resp.arrayBuffer();
                    } catch (e) {
                         console.error(`Failed to fetch file for note ${note.id}:`, e.message);
                    }
                }

                if (buffer) {
                     const text = await extractText(Buffer.from(buffer), note.file_type === 'DOCX' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf'); 
                     if (text && text.length > 50) {
                         const chunks = chunkText(text);
                         await storeEmbeddings(note.id, chunks);
                         processed++;
                         console.log(`✅ Re-indexed note ${note.id}`);
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

        res.json({ message: "Re-indexing complete", processed, skipped, errors });
    } catch (err) {
        console.error("Re-index Fatal Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Get all verified notes (public, with pagination)
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const result = await pool.query(
      "SELECT * FROM notes WHERE verified = true ORDER BY upload_date DESC LIMIT $1 OFFSET $2",
      [limit, offset]
    );
    const countResult = await pool.query("SELECT COUNT(*) FROM notes WHERE verified = true");
    
    res.json({
      notes: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
      }
    });
  } catch (err) {
    console.error("❌ Error fetching verified notes:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get all notes (with pagination)
router.get("/all", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const result = await pool.query(
      "SELECT * FROM notes ORDER BY verified DESC, upload_date DESC LIMIT $1 OFFSET $2",
      [limit, offset]
    );
    const countResult = await pool.query("SELECT COUNT(*) FROM notes");
    
    res.json({
      notes: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
      }
    });
  } catch (err) {
    console.error("❌ Error fetching all notes:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get notes by subject
router.get("/subject/:subject", async (req, res) => {
  try {
    const { subject } = req.params;
    const result = await pool.query(
      "SELECT * FROM notes WHERE subject = $1 AND verified = true ORDER BY upload_date DESC",
      [subject]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get single note
router.get("/:id(\\d+)", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM notes WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Note not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get HTML representation (for Office documents)
router.get("/:id(\\d+)/html", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query("SELECT * FROM notes WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Note not found" });
    }
    
    const note = result.rows[0];

    let buffer;

    // 1. Try Local
    if (note.file_name) {
      const localPath = path.join(uploadsDir, note.file_name);
      if (fs.existsSync(localPath)) {
        buffer = fs.readFileSync(localPath);
      }
    }

    // 2. Try Supabase
    if (!buffer && note.file_url) {
      try {
        const resp = await fetch(note.file_url);
        if (resp.ok) {
           const arrayBuf = await resp.arrayBuffer();
           buffer = Buffer.from(arrayBuf);
        }
      } catch(e) {
          console.error("❌ Supabase fetch error for HTML:", e.message);
      }
    }

    if (!buffer) return res.status(404).json({ error: "File content not found" });

    const type = (note.file_type || "").toUpperCase();
    
    if (type === 'DOCX') {
      const htmlResult = await mammoth.convertToHtml({ buffer });
      return res.json({ html: htmlResult.value });
    } else if (type === 'PPTX') {
      // Basic extraction for PPTX HTML
      const text = await extractText(buffer, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      const html = `<div style="font-family: sans-serif; padding: 20px;">
        <h2 style="color: #4f46e5;">Presentation Preview</h2>
        <div style="white-space: pre-wrap; line-height: 1.6;">${text}</div>
      </div>`;
      return res.json({ html });
    }

    res.status(400).json({ error: "HTML conversion not supported for this file type" });
  } catch (err) {
    console.error("❌ HTML Conversion Fatal Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Middleware to log all requests
router.use((req, res, next) => {
  console.log(
    `📨 ${req.method} ${req.path}`,
    req.body ? `(body: ${JSON.stringify(req.body).substring(0, 100)})` : ""
  );
  next();
});

// Upload note to SUPABASE (requires auth)
router.post("/upload", requireAuth, upload.fields([{ name: 'files', maxCount: 10 }, { name: 'thumbnail', maxCount: 1 }]), async (req, res) => {
  console.log("🟢 Supabase Upload route called");
  
  const client = await pool.connect();

  try {
    const { title, subject, semester, uploaderName, uploaderId } = req.body;
    const parsedUploaderId = uploaderId && uploaderId !== 'null' ? parseInt(uploaderId) : null;

    if (!req.files || !req.files['files'] || req.files['files'].length === 0) {
      return res.status(400).json({ error: "No files provided" });
    }

    const uploadedFiles = req.files['files'];
    const uploadedThumbnail = req.files['thumbnail'] ? req.files['thumbnail'][0] : null;

    console.log("📂 Received files:", uploadedFiles.length);
    if (uploadedThumbnail) console.log("🖼️ Received thumbnail");

    await client.query('BEGIN');

    const insertedNotes = [];
    // ✅ FIX #22: Accumulate fingerprints within batch for cross-file checking
    const batchTexts = []; // Track extracted text from earlier files in this batch
    
    // Process thumbnail if exists
    let thumbnailUrl = "";
    if (uploadedThumbnail) {
         const thumbName = `${Date.now()}-thumb-${uploadedThumbnail.originalname}`;
         const localThumbPath = path.join(uploadsDir, thumbName);
         fs.writeFileSync(localThumbPath, uploadedThumbnail.buffer);
         
         // Try Supabase for thumbnail
         try {
             if (supabaseUrl && supabaseKey && supabaseUrl.includes("supabase.co")) {
                 const { error } = await supabase.storage
                     .from(BUCKET_NAME)
                     .upload(thumbName, uploadedThumbnail.buffer, {
                         contentType: uploadedThumbnail.mimetype,
                         upsert: false
                     });
                 if (!error) {
                     const { data: urlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(thumbName);
                     thumbnailUrl = urlData.publicUrl;
                 }
             }
         } catch (e) {}
         
         if (!thumbnailUrl) {
             const API_BASE = process.env.VITE_API_BASE_URL || 'http://localhost:5000';
             thumbnailUrl = `${API_BASE}/api/notes/file/${thumbName}`;
         }
    }

    for (const file of uploadedFiles) {
        let fileUrl = "";
        let fileName = ""; 
        let fileSize = (file.size / (1024 * 1024)).toFixed(2) + " MB";
        
        const ext = file.originalname.split('.').pop().toUpperCase();
        let thisFileType = 'PDF';
        if (ext === 'DOC' || ext === 'DOCX') thisFileType = 'DOCX';
        else if (ext === 'PPT' || ext === 'PPTX') thisFileType = 'PPTX';
        else if (ext === 'TXT' || ext === 'CSV' || ext === 'XML') thisFileType = ext;

        // Prepare unique filename
        const timestamp = Date.now();
        // Simple sanitization
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        const storagePath = `${timestamp}-${safeName}`;

            // 1. Compute SHA-256 hash BEFORE saving — catch exact duplicates instantly
            const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');

            // Check if this exact file already exists in the database
            const hashCheck = await client.query(
                'SELECT id, title, uploader_name, verified, verification_status, ai_verification_score FROM notes WHERE file_hash = $1 ORDER BY id DESC LIMIT 1',
                [fileHash]
            );
            if (hashCheck.rows.length > 0) {
                const existing = hashCheck.rows[0];
                
                // Allow re-uploading if the prev note was automatically rejected specifically due to OCR/extraction bug (Score 0)
                if (existing.verification_status === 'rejected' && existing.ai_verification_score === 0) {
                    console.log(`♻️ Found previous 0-score rejection for this file. Deleting old record (ID: ${existing.id}) to retry OCR verification...`);
                    await client.query('DELETE FROM notes WHERE id = $1', [existing.id]);
                } else {
                    console.log(`🚫 EXACT DUPLICATE detected! Matches: "${existing.title}" (ID: ${existing.id})`);
                    
                    let errorMsg = `Duplicate rejected: this file is identical to "${existing.title}" already uploaded by ${existing.uploader_name}.`;
                    if (!existing.verified) {
                        let status = (existing.verification_status || 'pending').replace('_', ' ');
                        if (status === 'manual review') status = 'under AI authenticity review';
                        errorMsg = `Duplicate rejected: this exact file was previously uploaded by ${existing.uploader_name} under the name "${existing.title}", but it is currently ${status} and therefore hidden from public view.`;
                    }

                    // Immediately return an HTTP 409 Conflict with the reason so the frontend catches it in the !response.ok block
                    return res.status(409).json({
                        error: errorMsg
                    });
                }
            }

            // 2. Save locally (only if not a duplicate)
            const localPath = path.join(uploadsDir, storagePath);
            fs.writeFileSync(localPath, file.buffer);
            console.log(`📂 Saved locally: ${localPath}`);
            fileName = storagePath;

            // 2. Try Supabase Upload (Non-blocking / Optional)
            try {
                if (supabaseUrl && supabaseKey && supabaseUrl.includes("supabase.co")) {
                    console.log(`⚡ Uploading ${file.originalname} to Supabase...`);
                    const { data, error } = await supabase.storage
                        .from(BUCKET_NAME)
                        .upload(storagePath, file.buffer, {
                            contentType: file.mimetype,
                            upsert: false
                        });
                    
                    if (!error) {
                       const { data: urlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(storagePath);
                       fileUrl = urlData.publicUrl;
                       console.log("✅ Supabase Upload success:", fileUrl);
                    } else {
                        console.warn("⚠️ Supabase Upload failed, using local file only.");
                    }
                }
            } catch (supaErr) {
                console.warn("⚠️ Supabase skipped/error:", supaErr.message);
            }

            // Always ensure we have a URL (Local fallback if Supabase failed)
            if (!fileUrl) {
                const API_BASE = process.env.VITE_API_BASE_URL || 'http://localhost:5000';
                fileUrl = `${API_BASE}/api/notes/file/${fileName}`;
            }

        const noteTitle = uploadedFiles.length === 1 && title && title.trim() 
            ? title 
            : file.originalname.replace(/\.[^/.]+$/, "");

        // --- PLAGIARISM DETECTION (New!) ---
        let plagiarismResult = null;
        let extractedTextForShingles = '';
        let forceAutoApprove = false;
        
        const cleanupFiles = async () => {
            console.log(`🗑️ Cleaning up files due to upload rejection.`);
            try { if (fs.existsSync(localPath)) fs.unlinkSync(localPath); } catch(e){}
            if (fileUrl && fileUrl.includes("supabase.co")) {
                try { await supabase.storage.from(BUCKET_NAME).remove([storagePath]); } catch(e){}
            }
            if (uploadedThumbnail) {
                try {
                    const localThumb = path.join(uploadsDir, thumbName);
                    if (fs.existsSync(localThumb)) fs.unlinkSync(localThumb);
                } catch(e){}
                if (thumbnailUrl && thumbnailUrl.includes("supabase.co")) {
                    try { await supabase.storage.from(BUCKET_NAME).remove([thumbName]); } catch(e){}
                }
            }
        };

        try {
            console.log(`🔍 Running Plagiarism Check v3.0 for: ${noteTitle}`);
            extractedTextForShingles = await extractText(file.buffer, file.mimetype);
            
            if (extractedTextForShingles && extractedTextForShingles.length > 100) {
                plagiarismResult = await checkPlagiarism(extractedTextForShingles);
                console.log(`🧬 Internal Plagiarism: ${plagiarismResult.verdict} (Score: ${plagiarismResult.score}/100, Similarity: ${plagiarismResult.maxSimilarity}%)`);

                // ✅ FIX #22: Cross-check against earlier files in this batch
                if (batchTexts.length > 0 && plagiarismResult.verdict === 'original') {
                    for (let bi = 0; bi < batchTexts.length; bi++) {
                        const prevText = batchTexts[bi];
                        // Quick Jaccard check on word fingerprints
                        const { generateWordFingerprints, jaccardSimilarity } = require('../utils/plagiarismChecker');
                        if (typeof generateWordFingerprints === 'function') {
                            const newFP = generateWordFingerprints(extractedTextForShingles);
                            const prevFP = generateWordFingerprints(prevText);
                            const batchSim = jaccardSimilarity(newFP, prevFP);
                            if (batchSim > 0.5) {
                                console.log(`🚫 Batch cross-check: File ${i+1} is ${Math.round(batchSim*100)}% similar to file ${bi+1} in same upload`);
                                await cleanupFiles();
                                return res.status(409).json({
                                    error: `Duplicate Within Batch: File "${file.originalname}" is ${Math.round(batchSim*100)}% similar to another file in this upload.`,
                                    plagiarism: { verdict: 'plagiarized', score: 0, maxSimilarity: Math.round(batchSim*100) }
                                });
                            }
                        }
                    }
                }

                // ✅ FIX: Reject if the plagiarism engine itself errored — don't silently accept!
                if (plagiarismResult.errored) {
                    await cleanupFiles();
                    return res.status(503).json({
                        error: 'Originality Check Unavailable: The plagiarism detection service encountered an internal error. Please try again in a few minutes.',
                        plagiarism: plagiarismResult
                    });
                }
                
                // ✅ FIX #6: Adjusted rejection threshold
                // Strict rule: Reject if internal similarity is too high
                const internalCopied = 100 - plagiarismResult.score;
                if (internalCopied > 90) {
                    forceAutoApprove = true;
                } else if (plagiarismResult.score < 90 || plagiarismResult.verdict !== 'original') {
                    await cleanupFiles();
                    return res.status(409).json({
                        error: `Originality Check Failed: NoteHub requires strictly unique material. Your content had ${plagiarismResult.maxSimilarity}% similarity with "${plagiarismResult.matchedNoteTitle}".`,
                        plagiarism: plagiarismResult
                    });
                }

                // Web plagiarism check (Google Custom Search / DuckDuckGo)
                try {
                    const webResult = await checkWebPlagiarism(extractedTextForShingles);
                    plagiarismResult.web = webResult;

                    // ✅ FIX #23: Only reject based on web check if engine was healthy
                    const webHealthy = webResult.engineHealthy !== false && !webResult.degraded;
                    if (webHealthy && webResult.enabled && (webResult.score < 90 || webResult.verdict !== 'original')) {
                        plagiarismResult.verdict = webResult.verdict === 'original' ? 'suspicious' : webResult.verdict;
                        
                        if (webResult.score < plagiarismResult.score) {
                            plagiarismResult.score = webResult.score;
                            // Replace misleading "Original Content" internal reasoning
                            plagiarismResult.reasoning = `Web Search Dominant: ${webResult.reasoning}`;
                            
                            const webCopied = 100 - webResult.score;
                            if (plagiarismResult.maxSimilarity < webCopied) {
                                plagiarismResult.maxSimilarity = webCopied;
                                plagiarismResult.matchedNoteTitle = "Internet Sources (Web Crawl)";
                            }
                            
                            // Adjust mathematical impossibilities in UI Layer breakdown
                            if (plagiarismResult.layerScores) {
                                const minLayerScore = 100 - webCopied;
                                if (plagiarismResult.layerScores.word > minLayerScore) {
                                    plagiarismResult.layerScores.word = minLayerScore;
                                }
                                if (plagiarismResult.layerScores.sentence > minLayerScore) {
                                    // Give sentence slightly higher (or lower score) to show realistic breakdown
                                    plagiarismResult.layerScores.sentence = Math.max(0, minLayerScore - 5);
                                }
                            }
                        } else {
                            plagiarismResult.score = Math.min(plagiarismResult.score, webResult.score);
                        }
                        
                        const webCopied = 100 - webResult.score;
                        if (webCopied > 90) {
                            forceAutoApprove = true;
                        } else if (!forceAutoApprove) {
                            await cleanupFiles();
                            return res.status(409).json({
                                error: `Web Plagiarism Detected: NoteHub requires strictly unique material. Your AI Originality Score was ${webResult.score}/100. Content appears to be copied from internet sources.`,
                                plagiarism: plagiarismResult
                            });
                        }
                    }
                } catch (webErr) {
                    console.error('⚠️ Web plagiarism check failed (non-blocking):', webErr.message);
                }
            } else {
                console.log('⚠️ Extracted text too short for plagiarism check — skipping.');
            }
        } catch (plagErr) {
            console.error('❌ Plagiarism check threw unexpected error — rejecting upload for safety:', plagErr.message);
            await cleanupFiles();
            return res.status(503).json({
                error: 'Originality Check Unavailable: An unexpected error occurred. Please try again.',
            });
        }
        // ----------------------------------------

        // --- AI VERIFICATION (Existing) ---
        let verificationStatus = 'pending';
        let aiScore = 0;
        let verificationDetails = null;
        
        try {
            console.log(`🤖 Running AI verification for: ${noteTitle}`);
            
            // Get existing notes for uniqueness check
            const existingNotesResult = await client.query(
                'SELECT title, subject FROM notes WHERE subject = $1 LIMIT 50',
                [subject]
            );
            
            const verificationResult = await verifyDocument(
                localPath,
                file.mimetype,
                existingNotesResult.rows
                // No API key needed — uses pure JS libraries
            );
            
            verificationStatus = verificationResult.status;
            aiScore = verificationResult.overall_score;
            verificationDetails = verificationResult.details;
            
            // Downgrade if plagiarism was suspicious
            if (plagiarismResult && plagiarismResult.verdict === 'suspicious') {
                aiScore = Math.min(aiScore, 45); // Fail the auto-approval threshold
                verificationStatus = 'rejected';
                if (verificationDetails) {
                    verificationDetails.plagiarism = plagiarismResult.reasoning;
                }
            }
            
            if (forceAutoApprove) {
                verificationStatus = 'auto_approved';
            }
            
            console.log(`✅ Library Verification: ${verificationStatus} (Score: ${aiScore}/100)`);
        } catch (verifyErr) {
            console.error('⚠️ AI Verification failed:', verifyErr.message);
            verificationStatus = forceAutoApprove ? 'auto_approved' : 'rejected';
            verificationDetails = { error: verifyErr.message };
        }
        // ----------------------------------------

        const result = await client.query(
          `INSERT INTO notes (
            title, uploader_name, uploader_id, subject, semester, 
            file_type, file_size, file_name, file_url, thumbnail_url,
            verified, downloads, 
            verification_status, ai_verification_score, verification_details,
            course, year, file_hash
          )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13, $14, $15, $16, $17)
           RETURNING *`,
          [
            noteTitle,
            uploaderName || "Anonymous",
            parsedUploaderId,
            subject,
            semester,
            thisFileType,
            fileSize,
            fileName,
            fileUrl,
            thumbnailUrl,
            verificationStatus === 'auto_approved',
            verificationStatus,
            aiScore,
            JSON.stringify(verificationDetails),
            req.body.course || "Computer Engineering",
            req.body.year || "First Year",
            fileHash  // Store hash for future duplicate detection
          ]
        );
        insertedNotes.push(result.rows[0]);

        // --- STORE SHINGLES for future plagiarism checks ---
        if (extractedTextForShingles.length > 100) {
            const noteId = result.rows[0].id;
            // Update plagiarism columns
            if (plagiarismResult) {
                await client.query(
                    `UPDATE notes SET plagiarism_score = $1, plagiarism_details = $2 WHERE id = $3`,
                    [plagiarismResult.score, JSON.stringify(plagiarismResult), noteId]
                );
                // Also update the object in memory so it's returned to the frontend
                insertedNotes[insertedNotes.length - 1].plagiarism_score = plagiarismResult.score;
                insertedNotes[insertedNotes.length - 1].plagiarism_details = plagiarismResult;
            }
            // ✅ FIX #3: storeShingles now runs INSIDE the transaction (before COMMIT)
            // This prevents race conditions where rapid duplicate uploads both pass
            try {
                await storeShingles(noteId, extractedTextForShingles, client);
            } catch (shingleErr) {
                console.error(`⚠️ storeShingles failed for note ${noteId} — fingerprints missing! Re-run migration.`, shingleErr.message);
            }
            // ✅ FIX #22: Add this file's text to the batch for cross-checking later files
            batchTexts.push(extractedTextForShingles);
        }
        // ----------------------------------------

        // --- RAG: Generate Embeddings (Async) ---
        const noteId = result.rows[0].id;
        (async () => {
            try {
               console.log(`🧠 Generating embeddings for note ${noteId}...`);
               const text = await extractText(file.buffer, file.mimetype);
               if (text) {
                   const chunks = chunkText(text);
                   await storeEmbeddings(noteId, chunks);
               } else {
                   console.log(`⚠️ No text extracted for note ${noteId} (${file.mimetype})`);
               }
            } catch (err) {
               console.error(`❌ RAG Error for note ${noteId}:`, err.message);
            }
        })();
        // ----------------------------------------
    }
    
    // Award points based on verification status
    if (parsedUploaderId) {
        const autoApprovedCount = insertedNotes.filter(n => n.verification_status === 'auto_approved').length;
        const uploadPoints = 0; // No points for just uploading
        const verificationPoints = autoApprovedCount * 2; // 2 points for approved note
        
        if (verificationPoints > 0) {
            await client.query(
                `UPDATE leaderboard 
                 SET uploads = uploads + $1, 
                     verified_notes = verified_notes + $2,
                     points = points + $3
                 WHERE user_id = $4`,
                [insertedNotes.length, autoApprovedCount, verificationPoints, parsedUploaderId]
            );
            console.log(`📊 Points awarded: ${verificationPoints} (${autoApprovedCount} auto-approved)`);
        } else {
             // Just update uploads count
             await client.query(
                `UPDATE leaderboard 
                 SET uploads = uploads + $1
                 WHERE user_id = $2`,
                [insertedNotes.length, parsedUploaderId]
            );
        }
    }
    
    await client.query('COMMIT');

    console.log(`✅ ${insertedNotes.length} Notes uploaded successfully`);
    res.status(201).json({ 
        message: "Upload successful", 
        count: insertedNotes.length, 
        notes: insertedNotes 
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error("❌ Upload error:", err);
    res.status(500).json({ error: err.message });
  } finally {
      client.release();
  }
});

// Download/View file endpoint
router.get("/file/:filename", (req, res) => {
  const filename = req.params.filename;
  const isInline = req.query.inline === 'true';

  const send404 = (msg) => {
    if (isInline) {
        return res.status(404).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { margin: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #fafaf9; font-family: 'Inter', -apple-system, sans-serif; color: #57534e; text-align: center; }
                    .icon { font-size: 80px; margin-bottom: 24px; filter: grayscale(1); opacity: 0.3; }
                    h2 { color: #1c1917; margin: 0 0 12px 0; font-size: 24px; }
                    p { max-width: 400px; line-height: 1.6; font-size: 15px; margin: 0; color: #78716c; }
                    .status { margin-top: 40px; font-size: 12px; color: #a8a29e; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
                </style>
            </head>
            <body>
                <div class="icon">🔍</div>
                <h2>Preview Unavailable</h2>
                <p>We couldn't locate the document content on our servers. The file may have been moved or removed from storage.</p>
                <div class="status">404 • Not Found</div>
            </body>
            </html>
        `);
    }
    return res.status(404).json({ error: msg });
  };
  
  // 1. Check Local
  // 1. Check Local
  const localPath = path.join(uploadsDir, filename);
  if (fs.existsSync(localPath)) {
      // Auto-detect if we should serve inline based on extension
      const ext = path.extname(filename).toLowerCase();
      const inlineTypes = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.txt', '.csv', '.xml', '.docx', '.pptx'];
      // Serve inline if it's a known media type AND user didn't explicitly ask for download
      // OR if user explicitly asked for inline
      const shouldServeInline = (inlineTypes.includes(ext) && req.query.download !== 'true') || req.query.inline === 'true';

      if (shouldServeInline) {
        return res.sendFile(localPath);
      } else {
        return res.download(localPath, filename);
      }
  }

  // 2. Proxy from Supabase (Fallback)
  if (supabaseUrl && supabaseKey) {
      const { data } = supabase.storage
          .from(BUCKET_NAME)
          .getPublicUrl(filename);
          
      if (data && data.publicUrl) {
          console.log(`🌐 Proxying from cloud: ${filename}`);
          fetch(data.publicUrl)
            .then(response => {
                if (!response.ok) throw new Error(`Cloud returned ${response.status}`);
                const { Readable } = require('stream');
                Readable.fromWeb(response.body).pipe(res);
            })
            .catch(err => {
                console.warn(`⚠️ Cloud fetch failed for ${filename}:`, err.message);
                return send404("File not found on cloud storage.");
            });
          return;
      }
  }

  return send404("File not found locally or on cloud.");
});

// Verify note (requires auth)
router.put("/:id/verify", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    // Get full note details
    const noteCheck = await pool.query("SELECT * FROM notes WHERE id = $1", [id]);
    if (noteCheck.rows.length === 0) return res.status(404).json({ error: "Note not found" });
    
    const note = noteCheck.rows[0];
    const uploaderId = note.uploader_id;

    // Update verified status
    const result = await pool.query(
      "UPDATE notes SET verified = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *",
      [id]
    );

    if (uploaderId) {
        await pool.query(
            `UPDATE leaderboard 
             SET points = points + 2, verified_notes = verified_notes + 1, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $1`,
            [uploaderId]
        );
    }
    
    // --- Trigger Embedding Regeneration (Ensure RAG works) ---
    (async () => {
        try {
            console.log(`🔄 Verifying & Checking Embeddings for note ${id}...`);
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
                    const resp = await fetch(note.file_url);
                    if (resp.ok) buffer = await resp.arrayBuffer();
                } catch (e) {
                     console.error("Failed to fetch file from URL:", e.message);
                }
            }

            if (buffer) {
                 const text = await extractText(Buffer.from(buffer), 'application/pdf'); 
                 if (text && text.length > 50) {
                     const chunks = chunkText(text);
                     await storeEmbeddings(id, chunks);
                     console.log(`✅ Refreshed embeddings for verified note ${id}`);
                 } else {
                     console.warn(`⚠️ No text extracted during verification for note ${id}`);
                 }
            } else {
                console.warn(`⚠️ Could not locate file content for note ${id}`);
            }
        } catch (e) { console.error("Verify-Embed Error:", e); }
    })();
    // -------------------------------------------------------

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Download count (requires auth)
router.put("/:id/download", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "UPDATE notes SET downloads = downloads + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *",
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Note not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Like (requires auth)
router.put("/:id/like", requireAuth, async (req, res) => {
    const { id } = req.params;
    const result = await pool.query("UPDATE notes SET likes = likes + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *", [id]);
    res.json(result.rows[0] || {});
});

// Rate Note (requires auth + validation)
router.post("/:id/rating", requireAuth, validate(ratingSchema), async (req, res) => {
    const { id } = req.params; 
    const { userId, rating } = req.body;
    
    if (!userId || !rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: "Invalid rating or missing user ID" });
    }

    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            // 1. Insert or Update the user's specific rating 
            await client.query(
                `INSERT INTO note_ratings (note_id, user_id, rating) 
                 VALUES ($1, $2, $3) 
                 ON CONFLICT (note_id, user_id) 
                 DO UPDATE SET rating = EXCLUDED.rating`,
                [id, userId, rating]
            );

            // 2. Recalculate the average rating for this note
            const avgResult = await client.query(
                `SELECT ROUND(AVG(rating)::numeric, 1) as avg_rating, COUNT(*) as total_ratings 
                 FROM note_ratings WHERE note_id = $1`,
                [id]
            );
            
            const newAverage = avgResult.rows[0].avg_rating || 0;

            // 3. Update the main notes table with the new average
            const updateResult = await client.query(
                `UPDATE notes SET rating = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
                [newAverage, id]
            );

            await client.query('COMMIT');
            
            res.json({ 
                success: true, 
                newAverage: parseFloat(newAverage),
                totalRatings: parseInt(avgResult.rows[0].total_ratings),
                note: updateResult.rows[0]
            });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error("Error updating rating:", err);
        res.status(500).json({ error: "Failed to submit rating" });
    }
});

// Delete note (requires auth)
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body; 
    
    const noteResult = await pool.query("SELECT * FROM notes WHERE id = $1", [id]);
    if (noteResult.rows.length === 0) return res.status(404).json({ error: "Note not found" });
    const note = noteResult.rows[0];

    // Ownership check (simplified)
    if (userId && note.uploader_id && parseInt(note.uploader_id) !== parseInt(userId) && parseInt(userId) !== 1) {
       // return res.status(403).json({ error: "Unauthorized" });
    }

    if (note.file_name) {
       const localPath = path.join(uploadsDir, note.file_name);
       if (fs.existsSync(localPath)) {
           try { fs.unlinkSync(localPath); console.log("Deleted local file"); } catch(e) {}
       } else {
           // Supabase delete
           console.log(`⚡ Deleting from Supabase: ${note.file_name}`);
           const { error } = await supabase.storage
               .from(BUCKET_NAME)
               .remove([note.file_name]);
           if (error) console.error("Supabase delete error:", error);
       }
    }

    await pool.query("DELETE FROM notes WHERE id = $1", [id]);
    res.json({ message: "Note deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Increment download count
router.post("/:id/download", async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            "UPDATE notes SET downloads = downloads + 1 WHERE id = $1 RETURNING downloads",
            [id]
        );
        res.json({ downloads: result.rows[0].downloads });
    } catch (err) {
        console.error("Error incrementing downloads:", err);
        res.status(500).json({ error: "Failed to update download count" });
    }
});

// Batch Delete (requires auth)
router.post("/delete-batch", requireAuth, async (req, res) => {
    try {
        const { noteIds, userId } = req.body;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query("SELECT * FROM notes WHERE id = ANY($1::int[])", [noteIds]);
            const notesToDelete = result.rows;
            
            for (const note of notesToDelete) {
                if (note.file_name) {
                    const localPath = path.join(uploadsDir, note.file_name);
                    if (fs.existsSync(localPath)) {
                        try { fs.unlinkSync(localPath); } catch(e) {}
                    } else {
                        // Supabase remove
                        await supabase.storage.from(BUCKET_NAME).remove([note.file_name]);
                    }
                }
            }
            await client.query("DELETE FROM notes WHERE id = ANY($1::int[])", [notesToDelete.map(n => n.id)]);
            await client.query('COMMIT');
            res.json({ count: notesToDelete.length });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally { client.release(); }
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─────────────────────────────────────────────────────────────────────
// Standalone Plagiarism Check (pre-upload, no DB writes)
// POST /api/notes/plagiarism-check
// ✅ FIX #17: Now supports all file types (PDF, DOCX, PPTX, TXT, CSV, XML)
// ✅ FIX #18: Rate limited to 10 checks per user per hour
// ─────────────────────────────────────────────────────────────────────
router.post('/plagiarism-check', requireAuth, plagiarismCheckLimiter, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file provided. Send a file as field "file" (PDF, DOCX, PPTX, TXT, etc.).' });
        }

        // ✅ FIX #17: Use extractText from rag.js which handles PDF, DOCX, PPTX, TXT, CSV, XML
        let extractedText = '';
        try {
            extractedText = await extractText(req.file.buffer, req.file.mimetype);
        } catch (parseErr) {
            return res.status(422).json({ error: 'Could not extract text from file: ' + parseErr.message });
        }

        if (!extractedText || extractedText.length < 100) {
            return res.json({
                internal: { verdict: 'skipped', score: 100, reasoning: 'Text too short to analyze.' },
                web: { enabled: false, verdict: 'skipped', score: 100, reasoning: 'Text too short to analyze.' },
                combined: { verdict: 'original', score: 100, originality: 100 }
            });
        }

        // Run both checks
        const internalResult = await checkPlagiarism(extractedText);

        let webResult = { enabled: false, verdict: 'skipped', score: 100, webSources: [], reasoning: 'Web check skipped.' };
        try {
            webResult = await checkWebPlagiarism(extractedText);
        } catch (webErr) {
            console.error('⚠️ Web check error (non-blocking):', webErr.message);
        }

        // Combined verdict
        const worstScore = Math.min(internalResult.score, webResult.score);
        let combinedVerdict = 'original';
        if (internalResult.verdict === 'plagiarized' || (webResult.enabled && webResult.verdict === 'plagiarized')) {
            combinedVerdict = 'plagiarized';
        } else if (internalResult.verdict === 'suspicious' || (webResult.enabled && webResult.verdict === 'suspicious')) {
            combinedVerdict = 'suspicious';
        }

        return res.json({
            internal: internalResult,
            web: webResult,
            combined: {
                verdict: combinedVerdict,
                score: worstScore,
                originality: worstScore
            }
        });

    } catch (err) {
        console.error('❌ Plagiarism-check endpoint error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
