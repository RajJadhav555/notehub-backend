const express = require("express");
const router = express.Router();
const { searchSimilar } = require("../utils/rag");
const { callAI } = require("../utils/ai");

router.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    // Check Mistral key — but callAI auto-fallbacks, so just warn
    if (!process.env.MISTRAL_API_KEY && !process.env.GOOGLE_API_KEY && !process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "No AI API key configured. Set MISTRAL_API_KEY in .env" });
    }

    // --- Career Map Context (always available) ---
    const ENGINEERING_CAREER_MAP = `
    MASTER CAREER MAP (ENGINEERING & IT):
    
    1. COMPUTER SCIENCE / IT:
       - Software Engineer: (Frontend: React, Vue; Backend: Node, Go, Python; Fullstack)
       - AI/ML Engineer: (Python, PyTorch, RAG, LLMs, Data Science)
       - DevOps/SRE: (Docker, K8s, CI/CD, Cloud: AWS/Azure)
       - Cybersecurity: (Pen-testing, InfoSec, NetSec)
       - Mobile Dev: (React Native, Flutter, Swift, Kotlin)
       
    2. ELECTRONICS & COMMUNICATION (ECE):
       - Embedded Systems: (C/C++, Microcontrollers, RTOS)
       - VLSI Design: (Verilog, FPGA, ASIC)
       - IoT Engineer: (Sensors, Edge Computing)
       - Telecom Engineer: (5G, RF Design)
       
    3. MECHANICAL:
       - Design Engineer: (CAD, SolidWorks, CATIA)
       - Robotics/Mechatronics: (ROS, Control Systems)
       - Thermal/CFD Engineer: (Ansys, HVAC)
       
    4. CIVIL:
       - Structural Engineer
       - Construction Manager
       - Urban Planning
       
    5. ELECTRICAL:
       - Power Systems
       - Control Systems
       - EV (Electric Vehicle) Design
    `;

    // 1. Try RAG Context — non-blocking, gracefully skip if unavailable
    let contextString = "No specific user documents found.";
    try {
      const contextDocs = await searchSimilar(message);
      if (contextDocs && contextDocs.length > 0) {
        contextString = contextDocs.map((doc) => doc.content).join("\n---\n");
        console.log(`📚 CareerAI: Found ${contextDocs.length} relevant user docs.`);
      }
    } catch (ragErr) {
      console.warn("⚠️ RAG search unavailable (OpenAI embeddings not configured):", ragErr.message);
      // Continue without RAG — Mistral still works
    }

    const fullContext = `
    ${ENGINEERING_CAREER_MAP}
    
    USER SPECIFIC CONTEXT (from uploaded notes/resumes):
    ${contextString}
    `;

    // 2. Build messages for Mistral
    const messages = [
      {
        role: "system",
        content: `You are the NoteHub Career Expert, a strategic and empathetic mentor for Engineering students.
                
YOUR MISSION: Provide high-impact career roadmaps and guidance tailored to the user's specific timeline.

CORE DIRECTIVES:
1. CUSTOM TIMELINES: 
   - If the user asks for a roadmap in **Months** (e.g., 3 months, 6 months), structure the response using ### Month 1, ### Month 2, etc.
   - If the user asks for a roadmap in **Weeks**, structure it using ### Week 1-2, ### Week 3-4, etc., or individual weeks if the duration is short.
2. STRUCTURED CONTENT: Each time block must include:
   - **Focus Area**: What is the main goal of this period?
   - **Key Skills to Master**: Bulleted list of technical skills.
   - **Action Items**: Specific projects or tasks to complete.
   - **Recommended Resources**: Where to learn these (e.g., Coursera, GitHub, Official Docs).
3. STYLE:
   - Use ### for all section headings.
   - Use **Bold** for skills, tools, and important deadlines.
   - Start with a single, thoughtful sentence of encouragement related to their specific career goal.

Always be precise, actionable, and encouraging.`
      },
      {
        role: "user",
        content: message
      }
    ];

    // 3. Call AI (Mistral → Google → OpenAI → Ollama auto-selected)
    const data = await callAI(null, messages);

    if (!data.choices || data.choices.length === 0) {
      return res.json({ message: "I'm focusing on your career path... but I need a moment. Please ask again!" });
    }

    const reply = data.choices[0].message.content;
    res.json({ message: reply });

  } catch (err) {
    console.error("❌ CareerAI Error:", err.message);
    res.status(500).json({
      error: "Career AI encountered an error: " + err.message,
      message: "I'm having trouble connecting right now. Please check that the backend is running and try again."
    });
  }
});

module.exports = router;
