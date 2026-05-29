const express = require("express");
const pool = require("../db");
const { searchSimilar } = require('../utils/rag');
const { callAI } = require('../utils/ai');

const router = express.Router();

/**
 * Notes AI Chat Endpoint
 * POST /api/notes-ai/chat
 * Body: { message: string }
 * Response: { reply: string }
 */
router.post("/chat", async (req, res) => {
    console.log("🤖 Notes AI Chat Request Received");
    
    try {
        const { message } = req.body;
        
        // Validate input
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ 
                error: "Message is required and must be a non-empty string" 
            });
        }

        console.log(`📝 User Question: "${message.substring(0, 50)}..."`);
        
        // Step 1: Get relevant content from RAG (verified notes only)
        let contextString = "";
        try {
            const contextDocs = await searchSimilar(message, 15, true);
            if (contextDocs.length > 0) {
                contextString = contextDocs.map(doc => doc.content).join("\n---\n");
                console.log(`📚 Found ${contextDocs.length} relevant chunks from RAG`);
            } else {
                console.log("⚠️ No relevant chunks found in RAG");
            }
        } catch (ragError) {
            console.error("RAG Search Error:", ragError.message);
            // Continue without RAG context
        }
        
        // Step 2: Get metadata of all verified notes
        let notesList = "";
        try {
            const notesMetaResult = await pool.query(
                "SELECT id, title, subject, semester, uploader_name FROM notes WHERE verified = true ORDER BY upload_date DESC LIMIT 500"
            );
            
            if (notesMetaResult.rows.length > 0) {
                notesList = notesMetaResult.rows.map(n => 
                    `- "${n.title}" (Subject: ${n.subject}, Semester: ${n.semester}, ID: ${n.id})`
                ).join("\n");
                console.log(`📋 Found ${notesMetaResult.rows.length} verified notes`);
            } else {
                notesList = "No verified notes available yet.";
                console.log("⚠️ No verified notes in database");
            }
        } catch (dbError) {
            console.error("Database Error:", dbError.message);
            notesList = "Error retrieving notes list.";
        }
        
        // Step 3: Build context for AI
        const fullContext = `
List of Available VERIFIED Notes:
${notesList}

Detailed Content from Relevant Notes (RAG):
${contextString || "No specific detailed content found for this query."}
        `.trim();
        
        // Step 4: Prepare messages for AI
        const messages = [
            {
                role: "system",
                content: `You are the NoteHub AI Assistant, a thoughtful and highly intelligent Academic Study Partner.
                
YOUR MISSION: Provide clear, accurate, and encouraging academic guidance based on verified study materials.

CONTEXT:
${fullContext}

STYLE & TONE:
1. BE THOUGHTFUL: Start responses with a brief, empathetic sentence about the student's learning journey (e.g., "I've analyzed the available notes to help you understand [Topic] better...").
2. BE NEAT: Use clean, professional Markdown. 
   - Use ### for Section Headings.
   - Use **Bold** for key definitions and criteria.
   - Use Bulleted Lists for readability.
   - Use --- (Horizontal Rule) to separate different major points if the response is long.
3. BE PRECISE: Only use information from the provided "Detailed Content" (RAG) and "Notes List". 
4. CITATION: If you mention a specific concept from a note, briefly mention the note title in brackets, e.g., [From: "Data Structures Part 1"].

IF INFORMATION IS MISSING:
If the answer isn't in the context, say: "I've carefully checked the current study materials, but I couldn't find specific details on that. Would you like me to summarize the general concepts of [Topic] based on what I *do* know about previous chapters?"

Always aim to be the most helpful study partner possible.`
            },
            {
                role: "user",
                content: message
            }
        ];
        
        // Step 5: Call AI
        console.log("🚀 Calling AI...");
        const data = await callAI(null, messages);
        
        // Step 6: Extract and return response
        if (!data || !data.choices || data.choices.length === 0) {
            console.error("❌ AI returned no choices:", JSON.stringify(data));
            return res.json({ 
                reply: "I'm sorry, I couldn't process that right now. The AI service returned an unexpected response. Please try again." 
            });
        }

        const reply = data.choices[0].message.content;
        console.log(`✅ AI Response Generated (${reply.length} characters)`);
        
        res.json({ reply });

    } catch (err) {
        console.error("❌ Notes AI Error:", err);
        res.status(500).json({ 
            reply: `I encountered an internal error: ${err.message}. Please try again later.` 
        });
    }
});

module.exports = router;
