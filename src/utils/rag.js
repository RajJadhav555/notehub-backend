const pdf = require('pdf-parse');
const pool = require('../db');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const officeParser = require('officeparser');
const mammoth = require('mammoth');
const Tesseract = require('tesseract.js');

/**
 * Extracts text from a file buffer (supports PDF, DOCX, PPTX, TXT, CSV, XML).
 * @param {Buffer} buffer 
 * @param {string} mimeType 
 * @returns {Promise<string>} Extracted text
 */
async function extractText(buffer, mimeType) {
  if (!buffer) return "";

  try {
    if (mimeType === 'application/pdf') {
        const data = await pdf(buffer);
        return data.text;
    } 
    
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
        mimeType === 'application/msword') {
        // use mammoth for docx
        const result = await mammoth.extractRawText({ buffer: buffer });
        return result.value;
    }
    
    if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
        mimeType === 'application/vnd.ms-powerpoint') {
        // use officeparser for pptx - wrap in promise to ensure it works with await
        return new Promise((resolve, reject) => {
            officeParser.parseOffice(buffer, (err, data) => {
                if (err) return reject(new Error(err));
                resolve(data || "");
            });
        });
    }
    
    if (mimeType === 'text/plain' || mimeType === 'text/csv' || mimeType === 'text/xml' || mimeType === 'application/xml') {
        return buffer.toString('utf8');
    }

    if (mimeType.startsWith('image/')) {
        console.log(`🖼️ Running RAG OCR on image payload`);
        const worker = await Tesseract.createWorker('eng');
        const ret = await worker.recognize(buffer);
        await worker.terminate();
        return ret.data.text;
    }

  } catch (e) {
      console.error(`Text Extraction Error (${mimeType}):`, e.message);
  }
  
  return ""; 
}

/**
 * splits text into chunks
 * @param {string} text 
 * @param {number} chunkSize 
 * @returns {string[]}
 */
function chunkText(text, chunkSize = 1000) {
  const chunks = [];
  
  const cleanText = text.replace(/\s+/g, ' ').trim();
  
  for (let i = 0; i < cleanText.length; i += chunkSize) {
      chunks.push(cleanText.slice(i, i + chunkSize));
  }
  
  return chunks;
}

/**
 * Generates an embedding for a given text using Mistral.
 * @param {string} text 
 * @returns {Promise<number[]>} Vector embedding
 */
const { callAI } = require('./ai'); // Reuse client if possible, or just use openai package directly
const OpenAI = require("openai");


// Providers for Embeddings
const mistralKey = process.env.MISTRAL_API_KEY;
const googleKey = process.env.GOOGLE_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

// Clients
let openai = null;
let googleAI = null;

if (openaiKey) {
    openai = new OpenAI({ apiKey: openaiKey });
    console.log("🧬 RAG: Using OpenAI for embeddings");
} else if (mistralKey) {
    openai = new OpenAI({
        apiKey: mistralKey,
        baseURL: 'https://api.mistral.ai/v1',
    });
    console.log("🧬 RAG: Using Mistral for embeddings");
} else if (googleKey) {
    googleAI = new GoogleGenerativeAI(googleKey);
    console.log("🧬 RAG: Using Google Gemini for embeddings");
} else {
    console.warn("⚠️ No Embedding provider configured - RAG features will be limited");
}

/**
 * Generates an embedding for a given text using OpenAI (text-embedding-3-small).
 * @param {string} text 
 * @returns {Promise<number[]>} Vector embedding (1536 dimensions)
 */
async function generateEmbedding(text) {
  try {
    // 1. Try OpenAI / Mistral (OpenAI-compatible)
    if (openai) {
      const model = openaiKey ? "text-embedding-3-small" : "mistral-embed";
      const response = await openai.embeddings.create({
        model,
        input: text,
        encoding_format: "float",
      });
      return response.data[0].embedding;
    }
    
    // 2. Try Google
    if (googleAI) {
      const model = googleAI.getGenerativeModel({ model: "text-embedding-004"});
      const result = await model.embedContent(text);
      return result.embedding.values;
    }

    throw new Error("No embedding provider initialized (Missing OPENAI_API_KEY, MISTRAL_API_KEY, or GOOGLE_API_KEY)");
  } catch (error) {
    console.error("Embedding API Error:", error.message);
    throw error;
  }
}

/**
 * Stores embeddings for a note in the database.
 * @param {number} noteId 
 * @param {string[]} chunks 
 */
async function storeEmbeddings(noteId, chunks) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Clear existing embeddings for this note if any (re-indexing)
        await client.query('DELETE FROM note_embeddings WHERE note_id = $1', [noteId]);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (!chunk || chunk.length < 50) continue; // Skip very small chunks

            try {
                const vector = await generateEmbedding(chunk);
                // vector is array of numbers. pgvector format is string "[1,2,3...]"
                const vectorStr = JSON.stringify(vector);

                await client.query(
                    `INSERT INTO note_embeddings (note_id, chunk_index, content, embedding)
                     VALUES ($1, $2, $3, $4)`,
                    [noteId, i, chunk, vectorStr]
                );
            } catch (e) {
                console.error(`Failed to embed chunk ${i} for note ${noteId}:`, e.message);
                // Continue with other chunks
            }
        }

        await client.query('COMMIT');
        console.log(`✅ Stored ${chunks.length} chunks for note ${noteId}`);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Error storing embeddings:", e);
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Searches for relevant chunks using vector similarity.
 * @param {string} query 
 * @param {number} limit 
 * @returns {Promise<any[]>}
 */
async function searchSimilar(query, limit = 5, verifiedOnly = false) {
    try {
        const queryVector = await generateEmbedding(query);
        const vectorStr = JSON.stringify(queryVector);

        // Cosine distance operator is <=>
        // ✅ FIX #16: Include ne.note_id so callers can filter out self-matches
        let querySql = `
             SELECT ne.note_id, ne.content, 1 - (ne.embedding <=> $1) as similarity
             FROM note_embeddings ne
             JOIN notes n ON ne.note_id = n.id
             WHERE 1=1 
        `;
        
        const params = [vectorStr, limit];

        if (verifiedOnly) {
            querySql += ` AND n.verified = true `;
        }

        querySql += ` ORDER BY ne.embedding <=> $1 LIMIT $2`;

        const result = await pool.query(querySql, params);

        return result.rows;
    } catch (e) {
        console.error("Search Error:", e);
        return [];
    }
}

module.exports = {
    extractText,
    chunkText,
    storeEmbeddings,
    searchSimilar
};
