
const path = require('path');
const dotenv = require('dotenv');

// Load env (parent dir .env)
dotenv.config({ path: path.join(__dirname, '../.env') });

const { callAI } = require('./src/utils/ai');

async function test() {
    console.log("Testing AI...");
    try {
        const result = await callAI(null, [{ role: 'user', content: 'Say hello in French' }]);
        console.log("AI Response:", JSON.stringify(result, null, 2));
    } catch (e) {
        console.error("AI Test Failed:", e);
    }
}

test();
