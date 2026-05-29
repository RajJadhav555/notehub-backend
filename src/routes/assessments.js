const express = require('express');
const { callAI } = require('../utils/ai');

const router = express.Router();

/**
 * Quiz Generator Endpoint
 * POST /api/assessments/quiz
 * Body: { text: string, difficulty: string }
 * Response: { 
 *    mcqs: [{ question, options[], correctAnswerIndex }],
 *    flashcards: [{ front, back }]
 * }
 */
router.post('/quiz', async (req, res) => {
    try {
        const { text, difficulty = 'medium' } = req.body;

        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: "Text content is required." });
        }

        console.log(`🤖 Generating Quiz (Length: ${text.length}, Level: ${difficulty})...`);

        const prompt = `You are an expert academic tutor. Generate a quiz based strictly on the provided text.
        
TEXT:
${text.substring(0, 10000)}

INSTRUCTIONS:
1. Create 5 Multiple Choice Questions (MCQs) and 5 Flashcards.
2. The difficulty should be ${difficulty}.
3. The MCQs must have exactly 4 options.
4. Respond ONLY with valid JSON wrapped in a markdown code block:

\`\`\`json
{
  "mcqs": [
    {
      "question": "Sample Question?",
      "options": ["A", "B", "C", "D"],
      "correctAnswerIndex": 0
    }
  ],
  "flashcards": [
    {
      "front": "Term or Concept",
      "back": "Definition or Explanation"
    }
  ]
}
\`\`\`
`;

        const response = await callAI(process.env.OPENAI_API_KEY, [
            { role: 'user', content: prompt }
        ], { temperature: 0.7, jsonMode: false });

        const rawText = response.choices[0].message.content;
        
        // Robust JSON extraction from Markdown blocks
        const jsonMatch = rawText.match(/```json\n([\s\S]*?)\n```/) || rawText.match(/\{[\s\S]*\}/);
        
        if (!jsonMatch) {
            throw new Error("AI did not return valid JSON format.");
        }

        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const quizData = JSON.parse(jsonStr);

        res.json(quizData);

    } catch (err) {
        console.error("❌ Quiz Generation Error:", err.message);
        res.status(500).json({ error: "Failed to generate quiz. " + err.message });
    }
});

/**
 * Mock Exam Generator Endpoint
 * POST /api/assessments/exam
 * Body: { text: string }
 * Response: { 
 *    shortAnswer: [{ question }],
 *    essay: [{ prompt, expectedPoints[] }]
 * }
 */
router.post('/exam', async (req, res) => {
    try {
        const { text } = req.body;

        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: "Text content is required." });
        }

        console.log(`🤖 Generating Mock Exam (Length: ${text.length})...`);

        const prompt = `You are a college professor. Generate a mock exam based strictly on the provided text.

TEXT:
${text.substring(0, 10000)}

INSTRUCTIONS:
1. Create 4 Short Answer Questions and 2 Essay Prompts.
2. For essays, provide the 'expectedPoints' an ideal answer should cover.
3. Respond ONLY with valid JSON wrapped in a markdown code block:

\`\`\`json
{
  "shortAnswer": [
    { "question": "Explain X briefly." }
  ],
  "essay": [
    { 
      "prompt": "Discuss the impact of X on Y.",
      "expectedPoints": ["Point 1", "Point 2"]
    }
  ]
}
\`\`\`
`;

        const response = await callAI(process.env.OPENAI_API_KEY, [
            { role: 'user', content: prompt }
        ], { temperature: 0.7, jsonMode: false });

        const rawText = response.choices[0].message.content;
        
        const jsonMatch = rawText.match(/```json\n([\s\S]*?)\n```/) || rawText.match(/\{[\s\S]*\}/);
        
        if (!jsonMatch) {
            throw new Error("AI did not return valid JSON format.");
        }

        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const examData = JSON.parse(jsonStr);

        res.json(examData);

    } catch (err) {
        console.error("❌ Exam Generation Error:", err.message);
        res.status(500).json({ error: "Failed to generate exam. " + err.message });
    }
});

module.exports = router;
