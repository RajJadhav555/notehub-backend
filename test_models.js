const path = require('path');
// Try loading from current dir
require('dotenv').config();
// Try loading from parent dir
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function listModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    console.log("Checking API Key:", apiKey ? "Present" : "Missing");
    
    if (!apiKey) return;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await response.json();
        
        if (data.models) {
            console.log("✅ Available Models:");
            data.models.forEach(m => {
                // Filter for generateContent support
                if (m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent")) {
                    console.log(`- ${m.name}`);
                }
            });
        } else {
            console.error("❌ No models found or error:", JSON.stringify(data, null, 2));
        }
    } catch (e) {
        console.error("❌ Network/Script Error:", e);
    }
}

listModels();
