const express = require('express');
const multer = require('multer');
const { extractText } = require('../utils/rag');
const { callAI } = require('../utils/ai');

const router = express.Router();

// Memory storage for immediate processing
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit per file

router.post('/analyze', upload.array('files', 10), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "No files uploaded" });
        }

        console.log(`PYQ Analysis: Processing ${req.files.length} files`);

        // 1. Extract Text from all files
        let fullText = "";
        for (const file of req.files) {
            try {
                const text = await extractText(file.buffer, file.mimetype);
                if (text && text.length > 50) {
                    fullText += `\n\n--- DOCUMENT: ${file.originalname} ---\n${text}`;
                }
            } catch (e) {
                console.warn(`Failed to extract text from ${file.originalname}:`, e);
            }
        }
        
        if (!fullText || fullText.length < 50) {
            return res.status(400).json({ error: "Could not extract text from the documents. Please ensure they are valid text-based files." });
        }

        console.log(`PYQ Analysis: Extracted total ${fullText.length} characters.`);

        // 2. Process using Heuristics (No AI)
        // 2a. Simple Subject/Semester detection
        let subject = "Unknown Subject";
        let semester = "Unknown Semester/Year";
        
        // Simple regex to find year
        const yearMatch = fullText.match(/\b(20\d\d)\b/);
        if (yearMatch) semester = `Year ${yearMatch[1]}`;
        
        // Take the first line that looks like a title
        const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 5);
        if (lines.length > 0) {
           // Skip '--- DOCUMENT' lines
           const titleLine = lines.find(l => !l.startsWith('---'));
           if (titleLine) {
               subject = titleLine.substring(0, 40) + "..."; // Heuristic guess
           }
        }

        // 2b. Extract Questions using regex
        // Match things like "Q.1", "1)", "Q1", "Question 1:"
        const questionRegex = /(?:^|\n)(?:\s*)?(?:[Q|q](?:uestion)?\.?\s*\d+[\.\)]?|\d+[\.\)])\s*(.+?)(?=(?:\n\s*(?:[Q|q](?:uestion)?\.?\s*\d+[\.\)]?|\d+[\.\)]))|$)/gs;
        
        const extractedQuestions = [];
        let match;
        
        while ((match = questionRegex.exec(fullText)) !== null) {
            let questionText = match[1].trim();
            // Basic cleanup and sanity check
            if (questionText.length > 15 && questionText.length < 800) { 
                // Check if it has marks at the end, e.g., (5), [5], 5M, 5 Marks
                let marks = "Unknown";
                const marksMatch = questionText.match(/[\(\[]?(\d+)\s*(?:M|Marks?|m)[\)\]]?$/i) || questionText.match(/\[(\d+)\]$/);
                if (marksMatch) {
                    marks = marksMatch[1];
                    questionText = questionText.replace(marksMatch[0], '').trim();
                }
                
                extractedQuestions.push({
                    question: questionText.substring(0, 250) + (questionText.length > 250 ? '...' : ''),
                    marks: marks,
                    fullText: questionText.toLowerCase() 
                });
            }
        }
        
        // 2c. Identify frequent words for "Topics"
        const stopwords = ["the", "and", "a", "an", "is", "in", "it", "of", "to", "for", "with", "on", "as", "by", "at", "are", "this", "that", "be", "or", "from", "which", "what", "how", "explain", "describe", "write", "note", "short", "briefly", "define", "state", "discuss", "any", "two", "three", "different", "between", "documents", "document", "question", "paper", "marks", "where", "when", "why", "who", "your", "you", "not", "but", "also", "has", "have", "had", "will", "would", "can", "could", "should", "shall", "may", "might", "must", "do", "does", "did", "done", "doing", "give", "given", "giving", "make", "made", "making", "take", "taken", "taking", "use", "used", "using", "show", "shown", "showing", "find", "found", "finding", "get", "got", "getting", "set", "out", "all", "some", "any", "no", "every", "each", "both", "either", "neither", "such", "only", "same", "other", "another", "one", "first", "last", "next", "previous", "following", "above", "below", "under", "over", "before", "after", "during", "while", "since", "until", "through", "about", "against", "among", "around", "behind", "beneath", "beside", "besides", "beyond", "down", "into", "near", "off", "onto", "out", "over", "past", "through", "throughout", "till", "toward", "towards", "under", "underneath", "up", "upon", "within", "without"];
        
        const wordCounts = {};
        const words = fullText.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
        
        words.forEach(word => {
            if (word.length > 4 && !stopwords.includes(word)) { // Only words > 4 chars and not in stopwords
                wordCounts[word] = (wordCounts[word] || 0) + 1;
            }
        });
        
        // Top topics
        const topics = Object.keys(wordCounts)
            .map(word => ({ name: word.charAt(0).toUpperCase() + word.slice(1), count: wordCounts[word] }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 8); 
            
        // Pick questions that contain the most common topic words as FAQs
        extractedQuestions.forEach(q => {
            let topicMatches = 0;
            topics.forEach(t => {
                // simple word boundary match
                if (q.fullText.match(new RegExp(`\\b${t.name.toLowerCase()}\\b`))) {
                    topicMatches++;
                }
            });
            q.score = topicMatches;
            q.frequency = topicMatches >= 2 ? "High" : (topicMatches === 1 ? "Medium" : "Low");
        });
        
        extractedQuestions.sort((a, b) => b.score - a.score); // Sort by highest topic match
        
        const topFaqs = extractedQuestions.slice(0, 6).map(q => ({
            question: q.question,
            frequency: q.frequency,
            marks: q.marks !== "Unknown" ? q.marks : undefined
        }));

        let analysisResult = {
            subject: subject,
            semester: semester,
            topics: topics,
            faqs: topFaqs,
            summary: `Algorithmic analysis complete. Scanned ${req.files.length} paper(s) and extracted ${extractedQuestions.length} distinct questions. Key topics identified based on term frequency across the documents.`
        };

        // Add file metadata to response
        res.json({
            ...analysisResult,
            filesAnalyzed: req.files.map(f => f.originalname)
        });

    } catch (err) {
        console.error("PYQ Analysis Error:", err);
        res.status(500).json({ error: err.message || "Failed to analyze document" });
    }
});

module.exports = router;
