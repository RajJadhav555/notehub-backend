const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../db');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware/authMiddleware');
const { validate, signupSchema, loginSchema, googleAuthSchema } = require('../middleware/validators');

const router = express.Router();
// NOTE: Ideally this comes from process.env.GOOGLE_CLIENT_ID
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID');

// Ensure password_hash column exists (auto-migration)
async function ensurePasswordColumn() {
  try {
    const checkColumn = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'password_hash'
    `);
    
    if (checkColumn.rows.length === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN password_hash VARCHAR(255)`);
      console.log('✅ Added password_hash column to users table');
    }
  } catch (err) {
    console.error('Migration check error:', err.message);
  }
}
ensurePasswordColumn();

// --- Architectural Self-Healing Trigger ---
// Runs dynamically on login to enforce strict zero-error margins by aggressively overwriting stale cache counts
async function selfHealUserStats(userId) {
    try {
        const statsQuery = await pool.query(
          `SELECT 
            (SELECT COUNT(*) FROM notes WHERE uploader_id = $1 AND verification_status != 'rejected') as exact_uploads,
            (SELECT COUNT(*) FROM notes WHERE uploader_id = $1 AND verified = true) as exact_verified
           `,
          [userId]
        );
        const u = parseInt(statsQuery.rows[0].exact_uploads) || 0;
        const v = parseInt(statsQuery.rows[0].exact_verified) || 0;
        const p = v * 5; // Base points multiplier
        
        await pool.query(
            `UPDATE leaderboard SET uploads = $1, verified_notes = $2, points = $3 WHERE user_id = $4`,
            [u, v, p, userId]
        );
        return { exact_uploads: u, exact_verified: v, current_points: p };
    } catch (e) {
        console.error("Self-heal error:", e);
        return { exact_uploads: 0, exact_verified: 0, current_points: 0 };
    }
}

// Auth module loaded

router.post('/google', validate(googleAuthSchema), async (req, res) => {

  let lastStep = 'init';
  try {
    const { token } = req.body;
    
    lastStep = 'verifying_token';
    // Verify the token from Google
    // Verify the token from Google
    let payload;
    
    try {
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID',
        });
        payload = ticket.getPayload();
    } catch (verError) {
        if (verError.message.includes('Token used too early')) {
            console.log("AUTH_DEBUG: Clock skew detected. Starting manual verification...");
            
            // 1. Get Google's Certs (Promisified)
            const certs = await new Promise((resolve, reject) => {
                client.getFederatedSignonCerts((err, certs) => {
                    if (err) reject(err);
                    else resolve(certs);
                });
            });
            
            // 2. Decode to find KID
            const decoded = jwt.decode(token, { complete: true });
            if (!decoded) throw new Error("Failed to decode token for manual verification");
            
            const kid = decoded.header.kid;
            const cert = certs[kid];
            if (!cert) {
                console.log("AUTH_DEBUG: Cert keys available:", Object.keys(certs));
                throw new Error(`Certificate not found for KID: ${kid}`);
            }
            
            // 3. Verify Integrity (Signature) ignoring time
            payload = jwt.verify(token, cert, { 
                algorithms: ['RS256'],
                audience: process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID',
                issuer: ['https://accounts.google.com', 'accounts.google.com'],
                ignoreNotBefore: true,
                ignoreExpiration: true
            });
            
            // 4. Manually check time with SAFE tolerance (22000 seconds)
            const now = Date.now() / 1000;
            const tolerance = 300; // 5 minutes max clock skew
            
            if (payload.nbf && (payload.nbf > now + tolerance)) {
                throw new Error("Token used way too early (beyond tolerance)");
            }
            if (payload.exp && (payload.exp < now - tolerance)) {
                throw new Error("Token expired (beyond tolerance)");
            }
            console.log("✅ Manual verification successful with clock tolerance");
        } else {
            throw verError; // Re-throw other errors
        }
    }
    
    lastStep = 'extracting_payload';
    // Payload is already set above
    
    if (!payload) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { sub: googleId, email, name, picture } = payload;
    
    lastStep = 'querying_user';
    // Upsert user
    // We try to find by google_id or email
    let userResult = await pool.query(
      'SELECT * FROM users WHERE google_id = $1 OR email = $2',
      [googleId, email]
    );

    let user;
    let isNewUser = false;

    if (userResult.rows.length === 0) {
      lastStep = 'creating_new_user';
      // Create new user
      const newUserResult = await pool.query(
        `INSERT INTO users (google_id, email, name, picture, department, semester) 
         VALUES ($1, $2, $3, $4, 'General', 'Semester 1') 
         RETURNING *`,
        [googleId, email, name, picture]
      );
      user = newUserResult.rows[0];
      isNewUser = true;
    } else {
      lastStep = 'updating_existing_user';
      // Update existing user
      // If found by email but no google_id, we link them
      user = userResult.rows[0];
      const updateResult = await pool.query(
        `UPDATE users 
         SET google_id = $1, picture = $2, name = $3, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $4 
         RETURNING *`,
        [googleId, picture, name, user.id]
      );
      user = updateResult.rows[0];
      isNewUser = false;
    }

    lastStep = 'generating_session';
    // Create a simple session token (JWT) for our app
    const currentSessionToken = crypto.randomUUID();

    // Update user with new session token AND set them online immediately
    await pool.query(
      'UPDATE users SET current_session_token = $1, last_seen = NOW() WHERE id = $2',
      [currentSessionToken, user.id]
    );

    // Ensure user is in leaderboard (with default 0 points if new)
    await pool.query(
      `INSERT INTO leaderboard (user_id, name, points, uploads, verified_notes, rank) 
       VALUES ($1, $2, 0, 0, 0, 999) 
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id, user.name]
    );

    // Create a simple session token (JWT) for our app
    const sessionToken = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      process.env.JWT_SECRET || 'notehub_default_secret_key_2026',
      { expiresIn: '24h' }
    );

    // Fetch precise realtime valid uploads counts and force database self-healing
    const userStats = await selfHealUserStats(user.id);

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        picture: user.picture,
        semester: user.semester,
        department: user.department,
        verifiedNotes: parseInt(userStats.exact_verified) || 0,
        points: parseInt(userStats.current_points) || 0,
        rank: 0,
        uploads: parseInt(userStats.exact_uploads) || 0,
        badges: [],
        collaborations: 0,
        role: (process.env.ADMIN_EMAILS || '').includes(user.email) ? 'admin' : 'student'
      },
      token: sessionToken,
      sessionToken: currentSessionToken,
      isNewUser: isNewUser
    });

  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Auth failed: ' + error.message });
  }
});

// Student Signup with email/password
router.post('/signup', validate(signupSchema), async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    // Validate required fields
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    
    // Check if email already exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Email already exists. Please login instead.' });
    }
    
    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    
    // Create user
    const newUserResult = await pool.query(
      `INSERT INTO users (name, email, password_hash, department, semester) 
       VALUES ($1, $2, $3, 'General', 'Semester 1') 
       RETURNING *`,
      [name, email, passwordHash]
    );
    const user = newUserResult.rows[0];
    
    // Create leaderboard entry with initial points
    await pool.query(
      `INSERT INTO leaderboard (user_id, name, points, uploads, verified_notes) 
       VALUES ($1, $2, 10, 0, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id, name]
    );
    
    // Create session token
    const currentSessionToken = crypto.randomUUID();
    await pool.query(
      'UPDATE users SET current_session_token = $1, last_seen = NOW() WHERE id = $2',
      [currentSessionToken, user.id]
    );
    
    // Create JWT token
    const sessionToken = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      process.env.JWT_SECRET || 'notehub_default_secret_key_2026',
      { expiresIn: '24h' }
    );
    
    res.status(201).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        picture: null,
        semester: user.semester,
        department: user.department,
        verifiedNotes: 0,
        points: 10,
        rank: 0,
        uploads: 0,
        badges: [],
        collaborations: 0,
        role: 'student'
      },
      token: sessionToken,
      sessionToken: currentSessionToken,
      isNewUser: true
    });
    
  } catch (error) {
    console.error('Signup error:', error.message);
    res.status(500).json({ error: 'Signup failed: ' + error.message });
  }
});

// Student Login with email/password
router.post('/login', validate(loginSchema), async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Validate required fields
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    // Find user by email
    const userResult = await pool.query(
      `SELECT u.* FROM users u WHERE u.email = $1`,
      [email]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found. Please sign up first.' });
    }
    
    const user = userResult.rows[0];
    
    // Check if user has a password (might be Google-only user)
    if (!user.password_hash) {
      return res.status(400).json({ error: 'This account uses Google Sign-In. Please login with Google.' });
    }
    
    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid password. Please try again.' });
    }
    
    // Intercept with Self-Healing sync
    const healedStats = await selfHealUserStats(user.id);
    
    // Create session token
    const currentSessionToken = crypto.randomUUID();
    await pool.query(
      'UPDATE users SET current_session_token = $1, last_seen = NOW() WHERE id = $2',
      [currentSessionToken, user.id]
    );
    
    // Create JWT token
    const sessionToken = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      process.env.JWT_SECRET || 'notehub_default_secret_key_2026',
      { expiresIn: '24h' }
    );
    
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        picture: user.picture,
        semester: user.semester,
        department: user.department,
        verifiedNotes: healedStats.exact_verified,
        points: healedStats.current_points,
        rank: 0,
        uploads: healedStats.exact_uploads,
        badges: [],
        collaborations: 0,
        role: (process.env.ADMIN_EMAILS || '').includes(user.email) ? 'admin' : 'student'
      },
      token: sessionToken,
      sessionToken: currentSessionToken,
      isNewUser: false
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed: ' + error.message });
  }
});

// Logout endpoint
router.post('/logout', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Force user offline by setting last_seen to 10 minutes ago
    // Also clear session token to prevent reuse
    await pool.query(
      `UPDATE users 
       SET last_seen = NOW() - INTERVAL '10 minutes',
           current_session_token = NULL 
       WHERE id = $1`,
      [userId]
    );
    
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Delete Account endpoint — userId comes from JWT, not request body (prevents IDOR)
router.delete('/users/me', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id; // From JWT — never trust client-sent IDs for destructive ops

    // 1. Unlink Notes (Preserve them by setting uploader_id to NULL)
    await pool.query(
        `UPDATE notes SET uploader_id = NULL WHERE uploader_id = $1`,
        [userId]
    );

    // 2. Delete User (Cascade will handle group memberships, leaderboard, etc.)
    await pool.query(
        `DELETE FROM users WHERE id = $1`,
        [userId]
    );

    res.json({ success: true, message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;

