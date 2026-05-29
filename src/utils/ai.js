require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require("openai");
const Bottleneck = require("bottleneck");

// ─── Provider Detection ────────────────────────────────────────────────────────

const mistralKey = process.env.MISTRAL_API_KEY;
const googleKey  = process.env.GOOGLE_API_KEY;
const openaiKey  = process.env.OPENAI_API_KEY;

let genAI         = null;
let openaiConfig  = null;
let mistralConfig = null;
let activeProvider = null; // 'mistral' | 'google' | 'openai' | 'ollama'

// Initialize all available providers
if (mistralKey) {
  mistralConfig = new OpenAI({
    apiKey: mistralKey,
    baseURL: 'https://api.mistral.ai/v1',
    timeout: 30000, 
  });
  if (!activeProvider) activeProvider = 'mistral';
  console.log("🤖 AI: Mistral AI Provider initialized.");
}

if (googleKey) {
  genAI = new GoogleGenerativeAI(googleKey, { apiVersion: "v1" });
  if (!activeProvider) activeProvider = 'google';
  console.log("🤖 AI: Google Gemini Provider (Stable v1) initialized.");
}

if (openaiKey) {
  openaiConfig = new OpenAI({ apiKey: openaiKey, timeout: 30000 });
  if (!activeProvider) activeProvider = 'openai';
  console.log("🤖 AI: OpenAI Provider initialized.");
}

if (!activeProvider) {
  try {
    const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    openaiConfig = new OpenAI({ baseURL: `${ollamaBaseUrl}/v1`, apiKey: 'ollama', timeout: 45000 });
    activeProvider = 'ollama';
    console.log(`🤖 AI: Using Local OLLAMA Provider (${ollamaBaseUrl})`);
  } catch (e) {
    console.warn("⚠️ No AI provider configured");
  }
}

// Rate limiter
const limiter = new Bottleneck({
  minTime: activeProvider === 'ollama' ? 0 : 500,
  maxConcurrent: 1,
});

// ─── Main callAI ─────────────────────────────────────────────────────────────

async function callAI(_apiKey, messages, options = {}) {
  return limiter.schedule(async () => {
    if (!activeProvider) {
      throw new Error("AI not configured: set MISTRAL_API_KEY, GOOGLE_API_KEY, or OPENAI_API_KEY in .env");
    }
    try {
      if (activeProvider === 'mistral') return callMistralAPI(messages, options);
      if (activeProvider === 'google')  return callGemini(messages, options);
      return callOpenAI(messages, options, activeProvider === 'ollama');
    } catch (error) {
      console.error(`❌ AI Error (${activeProvider}):`, error.message);
      throw error;
    }
  });
}

// ─── Mistral (OpenAI-compatible) ─────────────────────────────────────────────

async function callMistralAPI(messages, options = {}) {
  const model = options.model || 'mistral-large-latest';
  const completion = await mistralConfig.chat.completions.create({
    model,
    messages,
    temperature: options.temperature || 0.7,
    ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  });
  console.log(`✅ AI (Mistral [${model}]): Request successful.`);
  return { choices: [{ message: { content: completion.choices[0].message.content } }] };
}

// ─── Google Gemini ────────────────────────────────────────────────────────────

function buildGeminiContents(messages) {
  const contents = [];
  let systemInstructionText = "";

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstructionText += (msg.content || msg.parts?.[0]?.text || "") + "\n";
    } else {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts = [];
      
      const sourceParts = [];
      if (Array.isArray(msg.parts)) {
        sourceParts.push(...msg.parts);
      } else if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (c.type === 'text') sourceParts.push({ text: c.text });
          if (c.type === 'image_url' && c.image_url?.url) {
            const mimeType = c.image_url.url.split(';base64,')[0].replace('data:', '') || 'image/jpeg';
            const data = c.image_url.url.split(';base64,')[1];
            sourceParts.push({ inlineData: { mimeType, data } });
          }
        }
      } else {
        sourceParts.push({ text: msg.content });
      }
      
      for (const p of sourceParts) {
        if (p.text) parts.push({ text: p.text });
        if (p.inlineData) {
          parts.push({ 
            inline_data: { 
              mime_type: p.inlineData.mimeType, 
              data: p.inlineData.data 
            } 
          });
        }
      }
      contents.push({ role, parts });
    }
  }

  // Prepend system instructions to first user message
  if (systemInstructionText && contents.length > 0 && contents[0].role === 'user') {
    contents[0].parts.unshift({ text: `INSTRUCTIONS:\n${systemInstructionText}\n\nUSER REQUEST:` });
  }

  return contents;
}

async function callGemini(messages, options = {}) {
  const modelName = options.model || "gemini-2.0-flash";
  const apiKey = googleKey;

  if (!apiKey) {
    throw new Error("Google API Key not found in .env");
  }

  const contents = buildGeminiContents(messages);

  const safetySetting = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
  ];

  // Strategy: Try v1beta with response_mime_type for JSON mode.
  // If v1beta fails, fall back to v1 without response_mime_type (prompt-based JSON).
  const apiVersions = options.jsonMode ? ['v1beta', 'v1'] : ['v1'];

  let lastError = null;

  for (const apiVersion of apiVersions) {
    const useStructuredJson = options.jsonMode && apiVersion === 'v1beta';
    const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${modelName}:generateContent?key=${apiKey}`;

    // If on v1 fallback for JSON mode, append a JSON reminder to the prompt
    let requestContents = contents;
    if (options.jsonMode && apiVersion === 'v1') {
      requestContents = JSON.parse(JSON.stringify(contents)); // deep clone
      const lastUserMsg = requestContents.filter(c => c.role === 'user').pop();
      if (lastUserMsg) {
        lastUserMsg.parts.push({ text: "\n\nIMPORTANT: You MUST respond with valid JSON only. No markdown, no explanation, just the raw JSON object." });
      }
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30-second strict freeze prevention
      
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: requestContents,
          generationConfig: {
            temperature: options.temperature || 0.7,
            ...(useStructuredJson ? { responseMimeType: "application/json" } : {})
          },
          safetySettings: safetySetting
        })
      });
      clearTimeout(timeoutId);

      const data = await response.json();

      if (!response.ok) {
        console.warn(`⚠️ Gemini ${apiVersion} Error (will ${apiVersions.indexOf(apiVersion) < apiVersions.length - 1 ? 'retry' : 'throw'}):`, data.error?.message);
        lastError = new Error(data.error?.message || "Google API Error");
        continue; // Try next API version
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      console.log(`✅ AI (Gemini ${apiVersion} [${modelName}]): Request successful.`);
      return { choices: [{ message: { content: text } }] };

    } catch (fetchError) {
      console.warn(`⚠️ Gemini ${apiVersion} fetch error:`, fetchError.message);
      lastError = fetchError;
      continue;
    }
  }

  // All versions failed
  throw lastError || new Error("All Gemini API versions failed");
}

// ─── OpenAI / Ollama ──────────────────────────────────────────────────────────

async function callOpenAI(messages, options, isOllama = false) {
  const defaultModel = isOllama ? "llama3" : "gpt-4o-mini";
  const model = options.model || defaultModel;
  const client = openaiConfig;

  const completion = await client.chat.completions.create({
    model,
    messages,
    temperature: options.temperature || 0.7,
    ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
  });

  console.log(`✅ AI (${isOllama ? 'Ollama' : 'OpenAI'} [${model}]): Request successful.`);
  return { choices: [{ message: { content: completion.choices[0].message.content } }] };
}

module.exports = { callAI, callMistral: callAI, callGemini };
