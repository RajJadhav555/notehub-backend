const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { validate, userUpdateSchema, pointsUpdateSchema } = require('../middleware/validators');

const router = express.Router();

async function getWinningDepartment() {
  const result = await pool.query(
    `WITH user_points AS (
       SELECT u.id, u.department, COALESCE(note_counts.upload_count, 0) * 5 as points
       FROM users u LEFT JOIN (SELECT uploader_id, COUNT(*) as upload_count FROM notes WHERE verified = true GROUP BY uploader_id) note_counts ON u.id = note_counts.uploader_id
     )
     SELECT department, CASE WHEN COUNT(id) > 0 THEN SUM(points)::numeric / COUNT(id) ELSE 0 END as average_points
     FROM user_points WHERE department IS NOT NULL AND department != '' GROUP BY department ORDER BY average_points DESC LIMIT 1`
  );
  if (result.rows.length === 0 || parseFloat(result.rows[0].average_points) <= 0) return null;
  return result.rows[0].department;
}

// Get all users with online status for collaboration
router.get('/collaborators', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id,
        u.name,
        u.email,
        u.department,
        u.picture,
        u.is_verified,
        COALESCE(note_counts.verified_count, 0) * 5 as base_points,
        COALESCE(note_counts.verified_count, 0) as uploads,
        CASE 
          WHEN u.last_seen > NOW() - INTERVAL '2 minutes' THEN true 
          ELSE false 
        END as is_online,
        u.last_seen
      FROM users u
      LEFT JOIN (
        SELECT uploader_id, COUNT(*) as verified_count 
        FROM notes 
        WHERE verified = true
        GROUP BY uploader_id
      ) note_counts ON u.id = note_counts.uploader_id
      ORDER BY 
        CASE WHEN u.last_seen > NOW() - INTERVAL '2 minutes' THEN 0 ELSE 1 END,
        points DESC NULLS LAST,
        u.name ASC
    `);
    
    const winningDepartment = await getWinningDepartment();
    const rowsWithFlare = result.rows.map(row => {
      const isWinner = winningDepartment ? row.department === winningDepartment : false;
      const hasFlare = isWinner && row.is_verified;
      return {
        ...row,
        points: hasFlare ? row.base_points * 1.1 : row.base_points,
        hasFlare
      };
    });
    
    res.json(rowsWithFlare);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get user profile
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT u.*, 
              (SELECT COUNT(*) FROM notes WHERE uploader_id = u.id AND verified = true) * 5 as base_points, 
              (SELECT COUNT(*) FROM notes WHERE uploader_id = u.id AND verification_status != 'rejected') as uploads, 
              (SELECT COUNT(*) FROM notes WHERE uploader_id = u.id AND verified = true) as verified_notes,
              l.rank
       FROM users u
       LEFT JOIN leaderboard l ON u.id = l.user_id
       WHERE u.id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const winningDept = await getWinningDepartment();
    const isWinner = winningDept ? result.rows[0].department === winningDept : false;
    const hasFlare = isWinner && result.rows[0].is_verified;
    
    const user = { 
      ...result.rows[0], 
      hasFlare, 
      points: hasFlare ? result.rows[0].base_points * 1.1 : result.rows[0].base_points 
    };
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get user by email
router.get('/email/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const result = await pool.query(
      `SELECT u.*, 
              (SELECT COUNT(*) FROM notes WHERE uploader_id = u.id AND verified = true) * 5 as base_points, 
              (SELECT COUNT(*) FROM notes WHERE uploader_id = u.id AND verification_status != 'rejected') as uploads, 
              (SELECT COUNT(*) FROM notes WHERE uploader_id = u.id AND verified = true) as verified_notes,
              l.rank
       FROM users u
       LEFT JOIN leaderboard l ON u.id = l.user_id
       WHERE u.email = $1`,
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const winningDept = await getWinningDepartment();
    const isWinner = winningDept ? result.rows[0].department === winningDept : false;
    const hasFlare = isWinner && result.rows[0].is_verified;
    
    const user = { 
      ...result.rows[0], 
      hasFlare, 
      points: hasFlare ? result.rows[0].base_points * 1.1 : result.rows[0].base_points 
    };
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Create user
router.post('/create', async (req, res) => {
  try {
    const { name, email, department, semester } = req.body;
    const result = await pool.query(
      'INSERT INTO users (name, email, department, semester) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, email, department, semester]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get all users (with pagination)
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const result = await pool.query('SELECT id, name, email, department, semester, picture, created_at FROM users LIMIT $1 OFFSET $2', [limit, offset]);
    const countResult = await pool.query('SELECT COUNT(*) FROM users');
    
    res.json({
      users: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Route moved up

// Update user profile (requires auth + validation)
router.put('/:id', requireAuth, validate(userUpdateSchema), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, department, semester, year } = req.body;
    
    // Check for Department Locking/Cooldown
    if (department) {
      const currentUserRes = await pool.query('SELECT department, department_last_changed FROM users WHERE id = $1', [id]);
      if (currentUserRes.rows.length > 0) {
        const currentUser = currentUserRes.rows[0];
        // If they already have a department and are trying to change it
        if (currentUser.department && currentUser.department !== department) {
          const lastChanged = currentUser.department_last_changed;
          if (lastChanged) {
            const daysSinceChange = Math.floor((new Date() - new Date(lastChanged)) / (1000 * 60 * 60 * 24));
            if (daysSinceChange < 30) {
              return res.status(403).json({
                error: 'Department Locked',
                message: `You can only change your department once every 30 days. Next change allowed in ${30 - daysSinceChange} days.`
              });
            }
          }
        }
      }
    }

    // Construct dynamic query
    const result = await pool.query(
      `UPDATE users 
       SET name = COALESCE($1, name), 
           department = COALESCE($2, department), 
           semester = COALESCE($3, semester), 
           year = COALESCE($4, year),
           department_last_changed = CASE WHEN $2 IS NOT NULL AND $2 != department THEN CURRENT_TIMESTAMP ELSE department_last_changed END,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $5 
       RETURNING *`,
      [name, department, semester, year, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update profile error:', err);
    // If column doesn't exist, try simpler update (fallback logic if needed, but for now assuming schema matches requirement)
    res.status(500).json({ error: err.message });
  }
});

// Update user points (requires auth + validation)
router.put('/:id/points', requireAuth, validate(pointsUpdateSchema), async (req, res) => {
  try {
    const { id } = req.params;
    const { points } = req.body;
    const result = await pool.query(
      'UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Update heartbeat (requires auth)
router.post('/heartbeat', requireAuth, async (req, res) => {
  try {
    const { userId, sessionToken } = req.body;
    if (!userId) return res.status(400).json({ error: 'User ID required' });

    // Validate Session Token
    const userRes = await pool.query('SELECT current_session_token FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    
    // If a session token exists in DB but doesn't match the request, deny access
    if (userRes.rows[0].current_session_token && userRes.rows[0].current_session_token !== sessionToken) {
       return res.status(401).json({ error: 'Session expired', code: 'SESSION_MISMATCH' });
    }
    
    await pool.query(
      'UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = $1',
      [userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Immediately mark a user offline (requires auth)
router.post('/:id/offline', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      "UPDATE users SET last_seen = NOW() - INTERVAL '5 minutes' WHERE id = $1",
      [id]
    );
    res.json({ success: true, message: 'User marked offline' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// AI ID Verification (requires auth)
const { verifyStudentId } = require('../utils/idVerifier');
const crypto = require('crypto');

router.post('/verify-id', requireAuth, async (req, res) => {
  try {
    const { files } = req.body; // Expecting an array of { data, mimeType }
    const userId = req.user.id;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'At least one document (ID Card) is required' });
    }

    // 0. Build Perceptual Hash (pHash) using Jimp to stop "Micro-Crop" bypass attacks
    const Jimp = require('jimp');
    let pHashes = [];
    for (const file of files) {
       let fallbackHash = crypto.createHash('sha256').update(file.data).digest('hex');
       try {
           // Skip Jimp for PDFs and files over 6MB (approx 8.5M base64 chars) to prevent server OOM
           if (file.mimeType === 'application/pdf' || file.data.length > 8500000) {
              console.log(`Bypassing Jimp for ${file.mimeType} or large file, using SHA256.`);
              pHashes.push(fallbackHash);
              continue;
           }

           const base64Data = file.data.includes(';base64,') ? file.data.split(';base64,')[1] : file.data;
           const buffer = Buffer.from(base64Data, 'base64');
           const img = await Jimp.read(buffer);
           pHashes.push(img.hash()); // Generates a resilient 64-bit structural hash
       } catch (err) {
           console.warn("Jimp pHash failed (corrupted/unsupported image), falling back to SHA256:", err.message);
           pHashes.push(fallbackHash);
       }
    }
    
    // Sort hashes deterministically so order of upload doesn't matter for the final string save
    pHashes.sort();
    const imageHash = pHashes.join('-'); 

    // 1. Check attempts & Fetch User Data
    const userRes = await pool.query('SELECT name, department, verification_attempts FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    if (user.verification_attempts >= 3) {
      return res.status(403).json({ error: 'Maximum verification attempts reached (3/3). Please contact your administrator.' });
    }

    // 1.5 Pre-flight Check: Has ANY of these specific documents been used by ANY user before?
    for (const hash of pHashes) {
        // Query to see if this single hash fragment exists in any saved id_card_hash string
        const duplicateIdCheck = await pool.query('SELECT name FROM users WHERE id_card_hash LIKE $1 OR id_card_hash = $2', [`%${hash}%`, hash]);
        if (duplicateIdCheck.rows.length > 0 && duplicateIdCheck.rows[0].name !== user.name) {
            return res.status(409).json({ error: `Verification Failed: A document in this upload has already been registered to another existing account.` });
        }
    }

    // 2. Run AI Verification 
    const result = await verifyStudentId(files, user.name, user.department);

    if (!result.verified) {
       await pool.query('UPDATE users SET verification_attempts = verification_attempts + 1 WHERE id = $1', [userId]);
       return res.json({
         success: false,
         extractedName: result.extractedName,
         extractedDept: result.extractedDept,
         reasoning: result.reasoning
       });
    }

    // Backend Override Defense: If the AI hallucinates 'verified: true' but the name is egregiously different
    const normalizedClaimed = (user.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedExtracted = (result.extractedName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // Basic subset check (e.g. John Doe in Johnathan Doe) or high similarity
    if (normalizedClaimed && normalizedExtracted && !normalizedClaimed.includes(normalizedExtracted) && !normalizedExtracted.includes(normalizedClaimed)) {
       console.log(`Backend override: Name Mismatch (User: ${user.name}, Extracted: ${result.extractedName})`);
       await pool.query('UPDATE users SET verification_attempts = verification_attempts + 1 WHERE id = $1', [userId]);
       return res.json({
         success: false,
         extractedName: result.extractedName,
         extractedDept: result.extractedDept,
         reasoning: "The name on the ID does not appear to match your account name."
       });
    }

    // 3. Update DB with Verification Data, Hash, and strict Name constraints
    try {
      await pool.query(
        `UPDATE users 
         SET is_verified = true, 
             id_card_hash = $1,
             verified_name = $2,
             verification_attempts = verification_attempts + 1 
         WHERE id = $3`,
        [imageHash, result.extractedName, userId]
      );
    } catch (dbErr) {
       if (dbErr.code === '23505' && dbErr.constraint === 'users_verified_name_key') {
          return res.status(409).json({ error: `Verification Failed: An active account already exists under the verified name "${result.extractedName}". Multiple accounts per student are strictly prohibited.` });
       }
       throw dbErr;
    }

    res.json({
      success: true,
      extractedName: result.extractedName,
      extractedDept: result.extractedDept,
      reasoning: "Identity securely verified and cryptographically locked."
    });

  } catch (err) {
    console.error('ID Verify Error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
