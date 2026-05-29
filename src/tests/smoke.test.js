/**
 * NoteHub Smoke Tests
 * Run: node src/tests/smoke.test.js
 * 
 * Tests basic endpoint behavior without needing a test framework.
 * Requires the backend to be running on PORT from .env.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const BASE = `http://localhost:${process.env.PORT || 5300}/api`;
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

async function run() {
  console.log(`\n🧪 NoteHub Smoke Tests (${BASE})\n`);

  // 1. Health — notes endpoint returns paginated response
  await test('GET /notes returns paginated response', async () => {
    const res = await fetch(`${BASE}/notes`);
    assert(res.ok, `Status ${res.status}`);
    const data = await res.json();
    assert(data.notes !== undefined, 'Missing "notes" key');
    assert(data.pagination !== undefined, 'Missing "pagination" key');
    assert(typeof data.pagination.total === 'number', 'pagination.total not a number');
  });

  // 2. Auth rejection — protected route without token
  await test('POST /notes/upload rejects without auth (401)', async () => {
    const res = await fetch(`${BASE}/notes/upload`, { method: 'POST' });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  // 3. Auth rejection — career chat without token
  await test('POST /career/chat rejects without auth (401)', async () => {
    const res = await fetch(`${BASE}/career/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test' }),
    });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  // 4. Validation — signup with invalid email
  await test('POST /auth/signup rejects invalid email (400)', async () => {
    const res = await fetch(`${BASE}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', email: 'not-an-email', password: '123456' }),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    const data = await res.json();
    assert(data.error === 'Validation failed', `Expected validation error, got: ${data.error}`);
  });

  // 5. Validation — login with missing password
  await test('POST /auth/login rejects missing password (400)', async () => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@test.com' }),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  // 6. Debug endpoint removed
  await test('GET /debug/uploads returns 404 (removed)', async () => {
    const res = await fetch(`${BASE.replace('/api', '')}/debug/uploads`);
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  // 7. Leaderboard is public
  await test('GET /leaderboard returns data', async () => {
    const res = await fetch(`${BASE}/leaderboard`);
    assert(res.ok, `Status ${res.status}`);
  });

  // 8. Users pagination
  await test('GET /users returns paginated response', async () => {
    const res = await fetch(`${BASE}/users`);
    assert(res.ok, `Status ${res.status}`);
    const data = await res.json();
    assert(data.users !== undefined, 'Missing "users" key');
    assert(data.pagination !== undefined, 'Missing "pagination" key');
  });

  // 9. Security headers (Helmet)
  await test('Response includes security headers', async () => {
    const res = await fetch(`${BASE}/notes`);
    assert(res.headers.has('x-content-type-options'), 'Missing X-Content-Type-Options');
    assert(res.headers.has('x-frame-options'), 'Missing X-Frame-Options');
  });

  // Summary
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
