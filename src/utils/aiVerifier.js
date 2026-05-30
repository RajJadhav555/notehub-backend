/**
 * NoteHub Document Verification System
 * Uses pure JavaScript libraries — NO AI calls:
 *   - bad-words + obscenity  → inappropriate/profanity text detection
 *   - simhash-js             → fast near-duplicate fingerprinting
 *   - natural (TF-IDF)       → educational quality heuristics
 *   - pgvector (existing RAG) → vector-based duplicate similarity
 */

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { searchSimilar } = require('./rag');
const officeParser = require('officeparser');
const mammoth = require('mammoth');
const { callAI } = require('./ai');

// --- Library Imports ---
const leoProfanity = require('leo-profanity');
const { RegExpMatcher, englishDataset, englishRecommendedTransformers } = require('obscenity');
const { SimHash } = require('simhash-js');
const natural = require('natural');
const Tesseract = require('tesseract.js');

// --- Initialise once at startup ---
// leo-profanity: CommonJS compatible profanity filter
leoProfanity.loadDictionary('en'); // Load English dictionary

const obscenityMatcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

const simHasher = new SimHash();
const TfIdf = natural.TfIdf;
const tokenizer = new natural.WordTokenizer();

// --- Educational Whitelist to prevent false positives ---
const EDUCATIONAL_WHITELIST = new Set([
  'asexual', 'sexual', 'sex', 'organ', 'reproductive', 'biology',
  'penetration', 'depth', 'shell', 'kernel', 'process', 'kill',
  'hack', 'hacker', 'exploit', 'security', 'analysis', 'analytical',
  'drug', 'pharmacology', 'acid', 'bomb', 'calorimeter', 'explosion',
  'fat', 'fatty', 'lipid', 'junk', 'dna', 'cock', 'stopcock',
  'titration', 'titrate', 'titrant', 'mount', 'mounting',
  'injection', 'inject', 'virus', 'infection', 'cancer', 'tumor'
]);


// ─────────────────────────────────────────────
// 1. TEXT EXTRACTION
// ─────────────────────────────────────────────

async function extractTextFromPDF(filePath) {
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text;
  } catch (error) {
    throw new Error(`Failed to extract text from PDF: ${error.message}`);
  }
}

async function extractText(filePath, mimeType) {
  console.log(`📄 Extracting text from: ${path.basename(filePath)} (${mimeType})`);
  
  if (!filePath) return "";
  const dataBuffer = fs.readFileSync(filePath);

  try {
    if (mimeType === 'application/pdf' || filePath.toLowerCase().endsWith('.pdf')) {
      const data = await pdfParse(dataBuffer);
      return data.text;
    }

    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
        mimeType === 'application/msword' ||
        filePath.toLowerCase().endsWith('.docx')) {
        const result = await mammoth.extractRawText({ buffer: dataBuffer });
        return result.value;
    }

    if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
        mimeType === 'application/vnd.ms-powerpoint' ||
        filePath.toLowerCase().endsWith('.pptx')) {
        // use officeparser for pptx - wrap in promise to ensure it works with await
        return new Promise((resolve, reject) => {
            officeParser.parseOffice(dataBuffer, (err, data) => {
                if (err) return reject(new Error(err));
                resolve(data || "");
            });
        });
    }
    
    if (mimeType === 'text/plain' || mimeType === 'text/csv' || mimeType === 'text/xml' || mimeType === 'application/xml' ||
        filePath.toLowerCase().endsWith('.txt') ||
        filePath.toLowerCase().endsWith('.csv') ||
        filePath.toLowerCase().endsWith('.xml')) {
        return dataBuffer.toString('utf8');
    }

    if (mimeType.startsWith('image/') || 
        filePath.toLowerCase().endsWith('.png') || 
        filePath.toLowerCase().endsWith('.jpg') || 
        filePath.toLowerCase().endsWith('.jpeg')) {
        console.log(`🖼️ Running OCR on image: ${path.basename(filePath)}`);
        const worker = await Tesseract.createWorker('eng');
        const ret = await worker.recognize(dataBuffer);
        await worker.terminate();
        return ret.data.text;
    }

    throw new Error(`Unsupported file type: ${mimeType}.`);
  } catch (e) {
      console.error(`Local Text Extraction Error (${mimeType}):`, e.message);
      throw e;
  }
}


// ─────────────────────────────────────────────
// 2. REDUNDANCY CHECK — pgvector cosine similarity
// ─────────────────────────────────────────────

async function checkRedundancy(content) {
  try {
    const fingerprint = content.substring(0, 2000);
    const similarDocs = await searchSimilar(fingerprint, 3);

    if (similarDocs.length > 0) {
      const topMatch = similarDocs[0];
      if (topMatch.similarity > 0.92) {
        return {
          score: 0,
          reasoning: `Highly identical document found in database (Similarity: ${(topMatch.similarity * 100).toFixed(1)}%). Rejected as duplicate.`
        };
      } else if (topMatch.similarity > 0.85) {
        return {
          score: 40,
          reasoning: `Significant content overlap detected (${(topMatch.similarity * 100).toFixed(1)}%) with existing notes.`
        };
      }
    }

    return { score: 100, reasoning: 'Content appears unique based on vector analysis.' };
  } catch (error) {
    console.warn('Redundancy check warning (pgvector not available):', error.message);
    return { score: 100, reasoning: 'Skipped vector redundancy check — RAG not available.' };
  }
}


// ─────────────────────────────────────────────
// 3. SIMHASH DUPLICATE CHECK — title + metadata level
// ─────────────────────────────────────────────

function checkSimhashDuplicate(content, existingNotes) {
  try {
    // Use the first 1500 chars as the document fingerprint
    const contentHash = simHasher.hash(content.substring(0, 1500).toLowerCase());

    let minDistance = Infinity;
    let closestTitle = null;

    for (const note of existingNotes.slice(0, 100)) {
      const existingText = `${note.title || ''} ${note.subject || ''} ${note.description || ''}`.toLowerCase();
      const existingHash = simHasher.hash(existingText);

      // Hamming distance: 0 = identical, >10 = different
      const dist = hammingDistance(contentHash, existingHash);
      if (dist < minDistance) {
        minDistance = dist;
        closestTitle = note.title;
      }
    }

    if (minDistance <= 3) {
      return {
        score: 10,
        reasoning: `Near-duplicate detected via SimHash (distance: ${minDistance}) — very similar to "${closestTitle}".`
      };
    } else if (minDistance <= 8) {
      return {
        score: 60,
        reasoning: `Moderate similarity detected (SimHash distance: ${minDistance}) with "${closestTitle}".`
      };
    }

    return { score: 100, reasoning: `Content appears unique (SimHash distance: ${minDistance}).` };
  } catch (err) {
    return { score: 80, reasoning: 'SimHash check skipped due to error.' };
  }
}

// Simple 32-bit hamming distance
function hammingDistance(a, b) {
  let diff = (a ^ b) >>> 0;
  let count = 0;
  while (diff) {
    count += diff & 1;
    diff >>>= 1;
  }
  return count;
}


// ─────────────────────────────────────────────
// 4. APPROPRIATENESS CHECK — bad-words + obscenity
// ─────────────────────────────────────────────

function checkAppropriateness(content) {
  // Sample a generous window of the document
  const sample = content.substring(0, 5000);
  const rawWords = tokenizer.tokenize(sample.toLowerCase()) || [];
  
  // Filter out whitelisted educational terms before checking
  const words = rawWords.filter(w => !EDUCATIONAL_WHITELIST.has(w));

  // --- leo-profanity check (CommonJS, fast) ---
  const profanityCount = words.filter(w => leoProfanity.check(w)).length;
  const profanityRatio = profanityCount / Math.max(words.length, 1);

  // --- obscenity check (handles leetspeak/bypass attempts) ---
  const obscenityMatches = obscenityMatcher.getAllMatches(sample);
  
  // Filter obscenity matches: if the match is part of a whitelisted word, ignore it
  const filteredObscenityCount = obscenityMatches.filter(match => {
    const matchedText = sample.substring(match.startIndex, match.endIndex).toLowerCase();
    // If the matched text is a substring of any whitelisted word, we might have a false positive
    const isWhitelisted = Array.from(EDUCATIONAL_WHITELIST).some(w => w.includes(matchedText) && matchedText.length > 2);
    return !isWhitelisted;
  }).length;

  // Heuristic: If content looks like OCR noise (high non-alphanumeric ratio), 
  // be extremely lenient as OCR garbage often triggers false positives.
  const nonAlphaRatio = (sample.match(/[^a-zA-Z0-9\s]/g) || []).length / Math.max(sample.length, 1);
  const isLikelyOCRNoise = nonAlphaRatio > 0.3 && rawWords.length < sample.length / 10;

  let score, reasoning, isAppropriate;

  // Relaxed thresholds for academic context
  const rejectionThreshold = isLikelyOCRNoise ? 0.25 : 0.12; // 12% profanity or 25% if noise
  const obscenityRejectionCount = isLikelyOCRNoise ? 15 : 8;

  if (filteredObscenityCount >= obscenityRejectionCount || profanityRatio > rejectionThreshold) {
    score = 0;
    isAppropriate = false;
    reasoning = `Highly inappropriate content: ${filteredObscenityCount} obscene phrase(s), ${profanityCount} profane word(s) (${(profanityRatio*100).toFixed(1)}% of text).`;
  } else if (filteredObscenityCount >= 4 || profanityRatio > 0.05) {
    score = 40;
    isAppropriate = true; // Downgrade to manual review instead of flat rejection
    reasoning = `Potentially inappropriate: ${filteredObscenityCount} matches and ${profanityCount} words detected. Flagged for manual review.`;
  } else if (filteredObscenityCount >= 1 || profanityCount >= 1) {
    score = 80;
    isAppropriate = true;
    reasoning = `Minor language markers: ${filteredObscenityCount} obscenity, ${profanityCount} profanity. Allowed.`;
  } else {
    score = 100;
    isAppropriate = true;
    reasoning = 'No inappropriate content detected.';
  }

  // If it's likely OCR noise from a handwritten note, ensure it doesn't fail just on "appropriateness"
  if (isLikelyOCRNoise && score < 70) {
    score = 70;
    isAppropriate = true;
    reasoning = "OCR noise detected in scan (likely hand-written). Bypassing standard appropriateness filter.";
  }

  return { score, isAppropriate, reasoning };
}


// ─────────────────────────────────────────────
// 5. EDUCATIONAL QUALITY — heuristic NLP analysis
// ─────────────────────────────────────────────

function checkEducationalQuality(content) {
  const sample = content.substring(0, 5000);
  const words = tokenizer.tokenize(sample.toLowerCase()) || [];
  const wordCount = Math.max(words.length, 1);
  const charCount = sample.length;

  // Heuristic 1: Minimum content density (very lenient lower bound)
  if (charCount < 10 || wordCount < 2) {
    return { score: 10, reasoning: 'Document is too short or sparse to be valid educational content.' };
  }

  // Heuristic 2: TF-IDF vocabulary richness
  const tfidf = new TfIdf();
  tfidf.addDocument(sample);
  let uniqueTerms = 0;
  tfidf.listTerms(0).forEach(() => uniqueTerms++);
  const vocabularyRichness = Math.min(uniqueTerms / wordCount, 1);

  // Heuristic 3: Check for educational keywords
  const educationalKeywords = [
    'definition', 'concept', 'theory', 'example', 'solution', 'explain',
    'describe', 'analysis', 'introduction', 'chapter', 'unit', 'module',
    'objective', 'summary', 'conclusion', 'formula', 'equation', 'proof',
    'theorem', 'algorithm', 'method', 'process', 'experiment', 'result',
    'question', 'answer', 'note', 'lecture', 'study', 'review'
  ];
  const foundKeywords = educationalKeywords.filter(kw => sample.toLowerCase().includes(kw));
  // Require fewer keywords to reach full score (4 = 100%)
  const keywordScore = Math.min((foundKeywords.length / 4) * 100, 100);

  // Heuristic 4: Detect raw question paper without solutions
  const questionPatterns = (sample.match(/\b(Q\.|Q\d+\.|Question \d+|Ques\.|Marks?:?\s*\[?\d+\]?)\b/gi) || []).length;
  const answerPatterns = (sample.match(/\b(Answer|Solution|Ans\.|Working|Explanation|Therefore|Hence)\b/gi) || []).length;
  const isRawQPaper = questionPatterns > 5 && answerPatterns < 2;

  if (isRawQPaper) {
    return {
      score: 20,
      reasoning: `Detected raw question paper without solutions (${questionPatterns} question markers, only ${answerPatterns} answer indicators). Add solutions/annotations.`
    };
  }

  // Heuristic 5: Spam / repetition detection
  const uniqueWordRatio = new Set(words).size / wordCount;
  if (uniqueWordRatio < 0.2) {
    return { score: 15, reasoning: 'Very high text repetition detected — likely spam or auto-generated.' };
  }

  // Compute final quality score
  const richnessPenalty = vocabularyRichness < 0.15 ? -20 : 0;
  const finalScore = Math.min(100, Math.round(
    (keywordScore * 0.5) +
    (Math.min(vocabularyRichness * 200, 50)) +
    richnessPenalty
  ));

  const reasoning = finalScore >= 70
    ? `Good educational content: ${foundKeywords.length} relevant keywords, vocabulary richness ${(vocabularyRichness * 100).toFixed(0)}%.`
    : `Below average quality: ${foundKeywords.length} keywords found, vocabulary richness only ${(vocabularyRichness * 100).toFixed(0)}%.`;

  return { score: Math.max(finalScore, 25), reasoning };
}


// ─────────────────────────────────────────────
// 6. MAIN VERIFY FUNCTION
// ─────────────────────────────────────────────

async function verifyDocument(filePath, mimeType, existingNotes = []) {
  console.log(`\n🔍 Starting Library-Based Verification for: ${path.basename(filePath)}`);

  try {
    // Step 1: Extract text
    const content = await extractText(filePath, mimeType);

    if (!content || String(content).trim().length < 20) {
      const stats = fs.statSync(filePath);
      if (stats.size > 20000) { // Enough for a scan
        try {
          const aiVerdict = await verifyHandwrittenNote(filePath, mimeType);
          
          // Ultra-lenient: Accept if it's academic, even if quality is very low (e.g. 10+)
          if (aiVerdict.is_academic && aiVerdict.is_appropriate && aiVerdict.quality_score >= 10) {
            return {
              status: 'auto_approved',
              overall_score: Math.max(15, Math.round((aiVerdict.quality_score + aiVerdict.legitimacy_score) / 2)),
              verified: true,
              details: {
                is_handwritten: true,
                quality_score: aiVerdict.quality_score,
                legitimacy_score: aiVerdict.legitimacy_score,
                summary: aiVerdict.summary,
                reasoning: aiVerdict.reasoning
              }
            };
          } else {
            return {
              status: 'rejected',
              overall_score: Math.min(aiVerdict.quality_score, 20),
              details: { 
                error: `Rejected by AI: ${aiVerdict.reasoning}`,
                is_handwritten: true,
                reason: aiVerdict.reasoning 
              }
            };
          }
        } catch (aiErr) {
          console.error("Handwritten AI Check Failed (Using Fallback Approval):", aiErr);
          // Fulfill "can it just go through" request: Auto-approve on technical failure
          return {
            status: 'auto_approved',
            overall_score: 25,
            verified: true,
            details: { 
              is_handwritten: true,
              warning: 'AI visibility issues encountered; passing as low-quality fallback.',
              error: aiErr.message
            }
          };
        }
      }
      return {
        status: 'rejected',
        overall_score: 0,
        details: { error: 'Document appears empty or has insufficient content.' }
      };
    }

    console.log(`✅ Extracted ${content.length} characters`);

    // Step 2: Run all checks in parallel
    // NOTE: appropriateness and quality are now synchronous (no AI)
    const [redundancyResult, simhashResult] = await Promise.all([
      checkRedundancy(content),
      Promise.resolve(checkSimhashDuplicate(content, existingNotes))
    ]);

    const appropriatenessResult = checkAppropriateness(content);
    const qualityResult = checkEducationalQuality(content);

    // Step 3: Weighted score
    // Combine vector + simhash for uniqueness (take the lower as the real signal)
    const uniquenessScore = Math.min(redundancyResult.score, simhashResult.score);

    let overallScore = Math.round(
      (uniquenessScore * 0.40) +         // 40% Uniqueness (duplicate check)
      (qualityResult.score * 0.40) +     // 40% Educational quality
      (appropriatenessResult.score * 0.20) // 20% Appropriateness
    );

    // Hard override: duplicates or inappropriate content always rejected
    if (uniquenessScore <= 10 || !appropriatenessResult.isAppropriate) {
      overallScore = Math.min(overallScore, 20);
    }

    // Step 4: Status
    let status;
    if (!appropriatenessResult.isAppropriate) {
      status = 'rejected';
    } else if (overallScore >= 50) {
      status = 'auto_approved';
    } else {
      status = 'rejected';
    }

    const result = {
      status,
      overall_score: overallScore,
      details: {
        uniqueness_score: uniquenessScore,
        redundancy_score: redundancyResult.score,
        simhash_score: simhashResult.score,
        quality_score: qualityResult.score,
        appropriateness_score: appropriatenessResult.score,
        reasoning: {
          redundancy: redundancyResult.reasoning,
          simhash: simhashResult.reasoning,
          quality: qualityResult.reasoning,
          appropriateness: appropriatenessResult.reasoning
        }
      }
    };

    console.log(`\n✅ Verification Result: ${status.toUpperCase()} (Score: ${overallScore}/100)`);
    console.log(`   Uniqueness   : ${uniquenessScore}/100`);
    console.log(`   Quality      : ${qualityResult.score}/100 — ${qualityResult.reasoning}`);
    console.log(`   Appropriate  : ${appropriatenessResult.score}/100 — ${appropriatenessResult.reasoning}`);

    return result;

  } catch (error) {
    console.error('❌ Verification error:', error);
    return {
      status: 'rejected',
      overall_score: 0,
      details: { error: error.message }
    };
  }
}


async function verifyHandwrittenNote(filePath, mimeType) {
  console.log(`👁️ Vision-AI Analyzing Handwriting: ${path.basename(filePath)}`);
  const dataBuffer = fs.readFileSync(filePath);
  const base64Data = dataBuffer.toString('base64');

  const prompt = `
    You are an expert academic moderator for NoteHub. 
    Analyze the attached image/document and determine its authenticity and legitimacy as an academic note.
    
    Requirements:
    1. Authenticity: Is it a real handwritten document? (Doodles, random photos, or non-educational content should be rejected).
    2. Legitimacy: Does it contain coherent academic information (e.g., math, science, history, coding notes)?
    3. Quality: Is it legible enough for others to study?
    
    Respond only with a JSON object in this format:
    {
      "is_academic": boolean,
      "is_appropriate": boolean,
      "quality_score": 0-100,
      "legitimacy_score": 0-100,
      "summary": "Brief 1-sentence summary of content",
      "reasoning": "Brief explanation of your verdict"
    }
  `;

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        {
          type: 'image_url',
          image_url: {
            url: `data:${mimeType.includes('pdf') ? 'application/pdf' : mimeType};base64,${base64Data}`
          }
        }
      ]
    }
  ];

  try {
    // callAI expects (_apiKey, messages, options)
    const response = await callAI(null, messages, { jsonMode: true, model: 'pixtral-12b-2409' });
    const content = typeof response.choices[0].message.content === 'string' 
        ? JSON.parse(response.choices[0].message.content)
        : response.choices[0].message.content;
    return content;
  } catch (e) {
    console.error("❌ Vision-AI Error:", e.message);
    throw e;
  }
}

module.exports = {
  verifyDocument,
  extractText,
  checkAppropriateness,
  checkEducationalQuality,
  checkSimhashDuplicate,
  verifyHandwrittenNote
};
