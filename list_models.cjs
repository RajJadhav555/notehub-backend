
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });

const apiKey = process.env.GOOGLE_API_KEY;

if (!apiKey) {
    console.error("No API KEY");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

async function listModels() {
    try {
        console.log("Fetching available models...");
        // Not all SDK versions expose listModels easily, let's try a direct test of known models
        const models = ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-pro", "gemini-1.0-pro"];
        
        for (const m of models) {
            try {
                const model = genAI.getGenerativeModel({ model: m });
                const result = await model.generateContent("Test");
                console.log(`✅ Model ${m} is working.`);
                return; 
            } catch (e) {
                console.log(`❌ Model ${m} failed: ${e.message.split('[')[0]}`);
            }
        }
    } catch (e) {
        console.error("List Models Failed:", e);
    }
}

listModels();
