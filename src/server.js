const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { initSocket } = require('./socket');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { requireAuth } = require('./middleware/authMiddleware');

// --- SECURITY: Crash immediately if JWT_SECRET is not configured ---
if (!process.env.JWT_SECRET) {
  console.error('\n❌ FATAL: JWT_SECRET environment variable is required.\n   Set it in .env or your environment before starting the server.\n');
  process.exit(1);
}

const app = express();

// Trust proxy for rate limiting behind reverse proxies (Hugging Face / Render)
app.set('trust proxy', 1);

// Log startup info
console.log('\nStarting NoteHub Backend...');
console.log('NODE_ENV:', process.env.NODE_ENV || 'development');
console.log('PORT:', process.env.PORT || 5000);

// Startup safety warnings
if (!process.env.GOOGLE_CLIENT_ID) console.warn('⚠️  GOOGLE_CLIENT_ID not set — Google login will fail');
if (!process.env.MISTRAL_API_KEY) console.warn('⚠️  MISTRAL_API_KEY not set — AI features will fail');
if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
  console.warn('⚠️  CORS_ORIGIN not set in production — defaulting to localhost origins');
}

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow Supabase file loading
  contentSecurityPolicy: false // Disable CSP for dev (enable + configure for production)
}));

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:5555', 'http://localhost:5173', 'http://localhost:3000', 'http://localhost:8000'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Extend timeout to 5 minutes for long-running AI requests (Ollama Llama 3)
app.use((req, res, next) => {
  res.setTimeout(300000); // 5 minutes
  next();
});

// Rate Limiters
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please wait a minute.' }
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI rate limit reached. Please wait a minute.' }
});

app.use(globalLimiter);

// Database connection
const pool = require('./db');
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// Run safe schema migrations on startup
async function runMigrations() {
  console.log('⏳ Starting DB migration check...');
  
  // Wait up to 30 seconds for DB to be ready
  let retries = 5;
  while (retries > 0) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      console.warn(`⏳ Waiting for DB... (${retries} retries left)`);
      retries--;
      if (retries === 0) throw err;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  const columns = [
    { name: 'file_hash', type: 'TEXT' },
    { name: 'thumbnail_url', type: 'TEXT' },
    { name: 'course', type: 'TEXT' },
    { name: 'year', type: 'TEXT' },
    { name: 'plagiarism_score', type: 'INTEGER' },
    { name: 'plagiarism_details', type: 'TEXT' }
  ];

  for (const col of columns) {
    try {
      await pool.query(`ALTER TABLE notes ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
      console.log(`✅ Column ${col.name} is ready.`);
    } catch (err) {
      console.warn(`⚠️ Error adding column ${col.name}:`, err.message);
    }
  }

  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notes_file_hash ON notes(file_hash)`);
    console.log('✅ Index idx_notes_file_hash is ready.');
  } catch (err) {
    console.warn('⚠️ Error creating index:', err.message);
  }
  
  console.log('🏁 DB migration check completed.');
}
runMigrations().catch(err => {
  console.error('❌ Critical error during migration:', err);
});

// Routes
const notesRouter = require('./routes/notes');
const usersRouter = require('./routes/users');
const leaderboardRouter = require('./routes/leaderboard');
const messagesRouter = require('./routes/messages');
const authRouter = require('./routes/auth_v2');
const careerRouter = require('./routes/career');
const scanRouter = require('./routes/scan');
const notesAiRouter = require('./routes/notes-ai');
const { specs, swaggerUi } = require('./utils/swagger');

// Swagger Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));

app.use('/api/notes', notesRouter);
app.use('/api/users', usersRouter);
app.use('/api/leaderboard', leaderboardRouter);
app.use('/api/messages', requireAuth, messagesRouter);
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/career', requireAuth, careerRouter);
app.use('/api/scan', requireAuth, scanRouter);
app.use('/api/notes-ai', aiLimiter, requireAuth, notesAiRouter);

const pyqRouter = require('./routes/pyq');
app.use('/api/pyq', pyqRouter);

const collaborationRouter = require('./routes/collaboration');
app.use('/api/collaboration', collaborationRouter);

const assessmentsRouter = require('./routes/assessments');
app.use('/api/assessments', assessmentsRouter);

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ 
      status: 'Server is running', 
      database: 'Connected',
      timestamp: new Date(),
      databaseTime: result.rows[0]
    });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(503).json({ 
      status: 'Server error',
      database: 'Disconnected',
      error: err.message,
      timestamp: new Date()
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'NoteHub Backend API',
    version: '1.0.0',
    endpoints: {
      notes: '/api/notes',
      users: '/api/users',
      leaderboard: '/api/leaderboard',
      messages: '/api/messages',
      health: '/health'
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({ 
    error: err.message,
    timestamp: new Date()
  });
});

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ NoteHub Backend running on port ${PORT}`);
  console.log(`📡 API available at http://0.0.0.0:${PORT}`);
  console.log(`📊 Health check: http://0.0.0.0:${PORT}/health`);
});

// Initialize Socket.io
initSocket(server);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    pool.end(() => {
      console.log('Database connection closed');
      process.exit(0);
    });
  });
});
