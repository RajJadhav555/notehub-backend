const express = require('express');
const router = express.Router();
const { callAI } = require('../utils/ai');

router.post('/', async (req, res) => {
  try {
    const { title, subject, semester, uploader } = req.body;
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: 'Server misconfiguration: API key missing' });
    }

    // Construct a prompt for AI
    const systemPrompt = `
      Analyze the following academic note metadata and simulate a content scan result.
      Please generate a rigid JSON response (no markdown) with the following fields:
      - academic_score (0-100)
      - plagiarism_risk (0-100)
      - inappropriate_score (0-100)
      - is_stem (boolean)
      - quality_rating ("High" / "Medium" / "Low")
      - verdict ("Suitable" / "Not Suitable" / "Needs Review")
      - recommendation ("Approve" / "Reject" / "Flag")
      - reasoning (A short sentence explaining why you gave these scores based on the title/subject)

      Base the scores on how "academic" and "legitimate" the title/subject sounds. 
      E.g., "Data Structures" -> High score. "Test" -> Low score.
    `;

    const userMessage = `Note Title: "${title}"\nSubject: "${subject}"\nSemester: "${semester}"\nUploader: "${uploader}"`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ];

    try {
      // Use jsonMode for structured output
      const data = await callAI(apiKey, messages, { jsonMode: true });

      if (!data.choices || data.choices.length === 0) {
        throw new Error("AI returned no results");
      }

      let text = data.choices[0].message.content;
      
      console.log("AI Raw Response:", text); // Proof of AI generation

      // Clean markdown if present
      text = text.replace(/```json/g, '').replace(/```/g, '').trim();
      
      const result = JSON.parse(text);
      res.json(result);

    } catch (error) {
       console.error('AI Scan Error:', error);
       throw error;
    }

  } catch (error) {
    console.error('Scan Failed:', error);
    res.status(500).json({ error: 'Scan Failed', details: error.message });
  }
});

module.exports = router;
