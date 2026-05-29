
const OpenAI = require("openai");
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function test() {
    console.log("Testing OpenAI...");
    try {
        const completion = await openai.chat.completions.create({
            messages: [{ role: "user", content: "Say hello" }],
            model: "gpt-4o-mini",
        });
        console.log("Response:", completion.choices[0].message.content);
    } catch (e) {
        console.error("OpenAI Test Failed:", e);
    }
}

test();
