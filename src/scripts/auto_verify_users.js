const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const pool = require('../db');

const DEPARTMENTS = [
  'Computer Engineering',
  'Information Technology',
  'Mechanical Engineering',
  'Civil Engineering',
  'Electrical Engineering'
];

async function autoVerifyUsers() {
  console.log("🚀 Starting Auto-Verification of all Database Users...");

  const client = await pool.connect();

  try {
    const { rows: users } = await client.query('SELECT id, name, email, is_verified, department FROM users WHERE is_verified = false OR department = \'General\'');
    
    if (users.length === 0) {
      console.log("✅ All users are already verified and assigned departments!");
      return;
    }

    console.log(`📋 Found ${users.length} unverified or 'General' users.`);

    for (const user of users) {
      // Pick a random department
      const randomDept = DEPARTMENTS[Math.floor(Math.random() * DEPARTMENTS.length)];
      
      console.log(`   🎓 Verifying ${user.name} (${user.email}) -> ${randomDept}`);
      
      await client.query(
        'UPDATE users SET is_verified = true, department = $1 WHERE id = $2',
        [randomDept, user.id]
      );
    }

    console.log(`\n✅ Successfully verified ${users.length} students! Leaderboards and gamification will now display correctly.`);

  } catch (error) {
    console.error("❌ Failed to verify users:", error);
  } finally {
    client.release();
    pool.end();
  }
}

autoVerifyUsers();
