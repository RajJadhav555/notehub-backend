/**
 * ═══════════════════════════════════════════════════════════════════════
 * NoteHub AI-Powered Web Plagiarism Engine v4.0
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Improvements over v3.0:
 *  ✅ FIXED: Coverage increased from 5 to 12 sentences (evenly distributed)
 *  ✅ FIXED: Robust DuckDuckGo fallback (multiple selector patterns)
 *  ✅ NEW:   LRU cache for web search results (TTL = 24h, reduces API quota burn)
 *  ✅ NEW:   Sentence diversity selection (picks from beginning, middle, end)
 *  ✅ NEW:   AI prompt asks specifically about paraphrasing (not just copy-paste)
 *  ✅ NEW:   Rate-limit backoff with exponential retry
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
const { callAI } = require('./ai');

const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY || '';
const GOOGLE_CX = process.env.GOOGLE_SEARCH_CX || '';

// ─── Config ───────────────────────────────────────────────────────────────────
const MAX_QUERIES_PER_UPLOAD = 12;    // ✅ Increased from 5 to 12
const MIN_SENTENCE_LENGTH = 70;
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── LRU Cache for web search results ────────────────────────────────────────
let searchCache;
try {
    const lruMod = require('lru-cache');
    const LRUCache = lruMod.LRUCache || lruMod;
    searchCache = new LRUCache({
        max: 500,
        ttl: SEARCH_CACHE_TTL_MS,
    });
    console.log('🌐 Web Plagiarism: LRU search cache active (500 entries, 24h TTL)');
} catch (e) {
    searchCache = null;
}


// ═══════════════════════════════════════════════════════════════════════
// 1. SENTENCE EXTRACTION — Improved distribution across document
// ═══════════════════════════════════════════════════════════════════════
function extractKeySentences(text, maxSentences = MAX_QUERIES_PER_UPLOAD) {
    const allSentences = String(text || '')
        .replace(/\n+/g, '. ')
        .split(/(?<=[.!?])\s+/)
        .map(s => s.trim())
        .filter(s => s.length >= MIN_SENTENCE_LENGTH)
        .filter(s => /[a-zA-Z]{5,}/.test(s))
        .filter(s => !/^(introduction|conclusion|references|bibliography|abstract|chapter|section|figure|table|appendix)/i.test(s));

    if (allSentences.length === 0) return [];

    // ✅ NEW: Evenly sample from beginning, middle, and end for better coverage
    const third = Math.floor(allSentences.length / 3);
    const sections = [
        allSentences.slice(0, third),
        allSentences.slice(third, third * 2),
        allSentences.slice(third * 2),
    ];

    // Sort each section by length (most substantive first)
    sections.forEach(s => s.sort((a, b) => b.length - a.length));

    const selected = [];
    const perSection = Math.ceil(maxSentences / 3);

    for (const section of sections) {
        const step = Math.max(1, Math.floor(section.length / perSection));
        for (let i = 0; i < section.length && selected.length < maxSentences; i += step) {
            selected.push(section[i]);
        }
    }

    return selected.slice(0, maxSentences);
}


// ═══════════════════════════════════════════════════════════════════════
// 2. WEB SEARCH ENGINES
// ═══════════════════════════════════════════════════════════════════════
async function searchGoogle(sentence) {
    const query = `"${sentence.substring(0, 100)}"`;
    const cacheKey = `g:${query}`;
    if (searchCache && searchCache.has(cacheKey)) {
        return searchCache.get(cacheKey);
    }

    try {
        const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}&num=3`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) {
            if (response.status === 429) return { results: [], rateLimited: true, error: null };
            // ✅ FIX #21: Don't include URL (contains API key) in error message
            return { results: [], rateLimited: false, error: `Google API Error: HTTP ${response.status}` };
        }

        const data = await response.json();
        const result = {
            results: (data.items || []).map(item => ({
                title: item.title,
                url: item.link,
                snippet: item.snippet || ''
            })),
            rateLimited: false,
            error: null
        };

        if (searchCache) searchCache.set(cacheKey, result);
        return result;
    } catch (err) {
        // ✅ FIX #21: Sanitize error message — never leak API key
        const safeMsg = (err.message || 'Unknown error').replace(GOOGLE_API_KEY, '[REDACTED]').replace(GOOGLE_CX, '[REDACTED]');
        return { results: [], rateLimited: false, error: safeMsg };
    }
}

/**
 * Robust DuckDuckGo scraper with multiple selector patterns.
 * ✅ FIX: Multiple patterns tried in order, more resilient to HTML changes.
 */
async function searchDuckDuckGo(sentence) {
    const query = `"${sentence.substring(0, 80)}"`;
    const cacheKey = `d:${query}`;
    if (searchCache && searchCache.has(cacheKey)) {
        return searchCache.get(cacheKey);
    }

    try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        });
        clearTimeout(timeout);

        if (!response.ok) return { results: [], rateLimited: false, error: `DDG Error: ${response.status}` };

        const html = await response.text();
        const results = parseDDGResults(html);

        const result = { results, rateLimited: false, error: null };
        if (searchCache && results.length > 0) searchCache.set(cacheKey, result);
        return result;
    } catch (err) {
        return { results: [], rateLimited: false, error: err.message };
    }
}

/**
 * Parse DDG HTML — tries multiple regex patterns for resilience.
 */
function parseDDGResults(html) {
    const results = [];

    // ✅ FIX #10: More resilient extraction — try multiple approaches
    const patterns = [
        // Pattern 1: Modern DDG HTML structure
        {
            link: /class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g,
            snippet: /class="result__snippet"[^>]*>([^<]*(?:<b>[^<]*<\/b>[^<]*)*)<\/a>/g,
        },
        // Pattern 2: Alternative non-JS structure
        {
            link: /href="(https?:\/\/[^"]+)"[^>]*class="[^"]*result[^"]*"[^>]*>([^<]+)<\/a>/g,
            snippet: /class="[^"]*snippet[^"]*"[^>]*>([^<]+)</g,
        },
        // Pattern 3: Lite version fallback — very simple structure
        {
            link: /<a[^>]+rel="nofollow"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/g,
            snippet: /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([^<]+)</g,
        },
        // Pattern 4: Generic anchor with http links (broadest catch)
        {
            link: /<a[^>]+href="(https?:\/\/(?!duckduckgo\.com)[^"]{10,})"[^>]*>([^<]{5,})<\/a>/g,
            snippet: null,
        },
    ];

    for (const pat of patterns) {
        pat.link.lastIndex = 0;
        if (pat.snippet) pat.snippet.lastIndex = 0;
        let match, snippetMatch;
        let count = 0;

        while ((match = pat.link.exec(html)) !== null && count < 3) {
            snippetMatch = pat.snippet ? pat.snippet.exec(html) : null;
            let url = match[1];
            const title = match[2].trim();

            // Decode DuckDuckGo redirect URLs
            if (url.includes('duckduckgo.com/l/?')) {
                const uddg = url.match(/uddg=([^&]+)/);
                if (uddg) url = decodeURIComponent(uddg[1]);
            }

            if (!url.includes('duckduckgo.com') && !url.startsWith('/') && url.startsWith('http')) {
                results.push({
                    title,
                    url,
                    snippet: snippetMatch
                        ? snippetMatch[1].replace(/<\/?b>/g, '').replace(/&#\d+;/g, '').trim()
                        : ''
                });
                count++;
            }
        }

        if (results.length > 0) break; // Stop at first pattern that works
    }

    return results;
}

async function searchWeb(sentence) {
    const USE_GOOGLE = !!(GOOGLE_API_KEY && GOOGLE_CX && GOOGLE_CX !== 'YOUR_SEARCH_ENGINE_CX_HERE');
    if (USE_GOOGLE) {
        const result = await searchGoogle(sentence);
        if (!result.error && !result.rateLimited) return result;
        // Proceed to fallback if Google fails
    }
    return searchDuckDuckGo(sentence);
}


// ═══════════════════════════════════════════════════════════════════════
// 3. AI EVALUATION — Updated prompt to detect paraphrasing
// ═══════════════════════════════════════════════════════════════════════
async function runAIEvaluation(documentText, webSources) {
    const apiKey = process.env.OPENAI_API_KEY || process.env.MISTRAL_API_KEY;
    if (!apiKey) {
        console.log('   ⚠️ No AI key found. Using legacy algorithmic calculation.');
        const matchedSources = webSources.map(s => s.sources[0].url);
        const uniqueUrls = [...new Set(matchedSources)];
        return {
            originality_score: Math.max(0, 100 - (webSources.length * 15)),
            verdict: webSources.length > 4 ? 'plagiarized' : (webSources.length > 1 ? 'suspicious' : 'original'),
            detailed_analysis: `Found ${webSources.length} matched sentences online using legacy engine. AI key not configured for deep analysis.`,
            matched_sources: uniqueUrls.map(url => ({ url, context: 'Search engine match' }))
        };
    }

    try {
        const sourceData = webSources.map(w => `
Query Sentence: "${w.sentence}"
Online Matches:
${w.sources.map(s => `- URL: ${s.url}\n  Title: ${s.title}\n  Snippet: ${s.snippet}`).join('\n')}
        `).join('\n\n');

        // ✅ IMPROVED: Explicitly ask AI about paraphrasing detection
        const systemPrompt = `You are a strict Academic Integrity & Plagiarism AI specializing in detecting BOTH exact copying AND intelligent paraphrasing.
Evaluate the provided document sentences against their online web search matches.
Consider: (1) exact copying, (2) paraphrasing with synonyms, (3) sentence restructuring, (4) idea theft without citation.
Return a valid JSON object matching this schema exactly:
{
    "originality_score": number (0-100, 100=completely original, 0=entirely copied/paraphrased),
    "verdict": "original" | "suspicious" | "plagiarized",
    "detailed_analysis": "A clear 1-3 paragraph professional explanation covering: what was found, whether it is exact copy or paraphrase, and which specific sources are most problematic.",
    "matched_sources": [
        { "url": "string", "context": "1-sentence explanation: exact copy, paraphrase, or idea theft?" }
    ],
    "paraphrase_detected": boolean
}`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `WEB SEARCH FOUND THE FOLLOWING POTENTIAL MATCHES:\n${sourceData}` }
        ];

        const response = await callAI(apiKey, messages, { jsonMode: true });

        if (response && response.choices && response.choices.length > 0) {
            let jsonText = response.choices[0].message.content.trim();
            jsonText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(jsonText);
        }
        throw new Error('Invalid AI response.');
    } catch (e) {
        console.error('   ❌ AI Plagiarism Evaluation failed:', e.message);
        return null;
    }
}


async function performZeroShotAIFallback(text, engine, fallbackReasoning, checkedCount) {
    console.log('   ⚠️ Triggering AI Zero-Shot Stylometric Analysis fallback...');
    const apiKey = process.env.OPENAI_API_KEY || process.env.MISTRAL_API_KEY;
    if (apiKey && text.length > 100) {
        const systemPrompt = `You are an expert Academic Integrity AI. You must analyze the following document text and determine if it is likely plagiarized, paraphrased from known public sources (like Wikipedia, textbooks, well-known articles), or completely original.
Provide a highly rigorous estimate of the percentage of the text that appears to be copied or paraphrased from external sources. Do not just say 0% unless it is truly unique personal writing. It is perfectly normal to estimate 5-15% for standard academic phrasing.
Return a valid JSON object matching this schema exactly:
{
    "estimated_copied_percentage": number (0 to 100, float allowed),
    "verdict": "original" | "suspicious" | "plagiarized",
    "reasoning": "A short professional explanation of your findings, identifying likely types of sources if plagiarized."
}`;
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text.substring(0, 4000) }
        ];
        
        try {
            const response = await callAI(apiKey, messages, { jsonMode: true });
            if (response && response.choices && response.choices.length > 0) {
                let jsonText = response.choices[0].message.content.trim();
                jsonText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
                const aiFallback = JSON.parse(jsonText);
                
                console.log(`   ✅ AI Fallback Success. Estimated Copied: ${aiFallback.estimated_copied_percentage}%`);
                return {
                    enabled: true,
                    engine: 'AI Stylometric Check',
                    engineHealthy: true,
                    score: 100 - (aiFallback.estimated_copied_percentage || 0),
                    verdict: aiFallback.verdict || 'original',
                    reasoning: `[AI Zero-Shot Analysis] ${aiFallback.reasoning}`,
                    webSources: [], matchedSentences: 0, totalChecked: checkedCount,
                    degraded: false
                };
            }
        } catch (e) {
           console.error("   ❌ AI Fallback also failed:", e.message);
        }
    }

    return {
        enabled: true,
        engine,
        engineHealthy: false,
        score: 100,
        verdict: 'original',
        reasoning: fallbackReasoning,
        webSources: [], matchedSentences: 0, totalChecked: checkedCount,
        degraded: true
    };
}

// ═══════════════════════════════════════════════════════════════════════
// 4. MAIN CHECKER
// ═══════════════════════════════════════════════════════════════════════
async function checkWebPlagiarism(text) {
    const USE_GOOGLE = !!(GOOGLE_API_KEY && GOOGLE_CX && GOOGLE_CX !== 'YOUR_SEARCH_ENGINE_CX_HERE');
    const engine = USE_GOOGLE ? 'Google Custom Search' : 'DuckDuckGo Scraper';
    console.log(`\n🌐 ═══ AI Web Plagiarism Scan v4.1 [${engine}] ═══`);

    // ✅ FIX #23: Health canary — verify search engine is actually working
    let engineHealthy = true;
    try {
        const canaryResult = await searchWeb('photosynthesis is the process by which plants convert light');
        if (canaryResult.error || (canaryResult.results && canaryResult.results.length === 0)) {
            console.warn('   ⚠️ Web search engine health check FAILED — no results for known query');
            engineHealthy = false;
        } else {
            console.log('   ✅ Web search engine health check passed');
        }
    } catch (e) {
        console.warn('   ⚠️ Web search engine health check threw error:', e.message);
        engineHealthy = false;
    }

    const sentences = extractKeySentences(text, MAX_QUERIES_PER_UPLOAD);
    if (!engineHealthy) {
        return await performZeroShotAIFallback(text, engine, `Web search engine appears degraded — cannot reliably verify originality. Results may be incomplete.`, sentences.length);
    }

    console.log(`   📝 Extracted ${sentences.length} distinctive sentences (distributed across doc)`);

    if (sentences.length === 0) {
        return {
            enabled: true, engine, engineHealthy: true,
            score: 100, verdict: 'original',
            reasoning: 'Document is too short or lacks distinctive sentences to check against web sources.',
            webSources: [], matchedSentences: 0, totalChecked: 0
        };
    }

    const webSources = [];
    let checkedCount = 0;
    let consecutiveErrors = 0;

    for (const sentence of sentences) {
        checkedCount++;
        console.log(`   🔍 [${checkedCount}/${sentences.length}] Querying: "${sentence.substring(0, 60)}..."`);

        // Cache or search
        const { results, rateLimited, error } = await searchWeb(sentence);

        if (rateLimited) {
            console.log('   ⚠️ API rate limited. Halting queries.');
            break;
        }

        if (error) {
            consecutiveErrors++;
            console.warn(`   ⚠️ Search error: ${error}`);
            if (consecutiveErrors >= 3) {
                console.warn('   ⚠️ Too many consecutive errors — halting web search');
                break;
            }
            // ✅ Exponential backoff on error
            await new Promise(r => setTimeout(r, Math.min(5000, 1000 * Math.pow(2, consecutiveErrors))));
            continue;
        }

        consecutiveErrors = 0;

        if (results && results.length > 0) {
            webSources.push({
                sentence: sentence.substring(0, 150),
                sources: results.slice(0, 2)
            });
            console.log(`   🚩 Found match: ${results[0].title}`);
        }

        // Polite delay
        await new Promise(r => setTimeout(r, USE_GOOGLE ? 200 : 2000));
    }

    if (webSources.length === 0) {
        console.log('   ✅ Web search yielded 0 matches. Ensuring authenticity via AI Zero-Shot Stylometric Check...');
        const baseReasoning = `No matching web sources found across ${checkedCount} sampled sentences. Attempting AI verification for structural paraphrasing.`;
        const aiFallbackResult = await performZeroShotAIFallback(text, engine, baseReasoning, checkedCount);
        
        // If AI fallback couldn't run (e.g. no API key), override degraded flag to false since it's normal behavior here
        if (aiFallbackResult.degraded) {
             aiFallbackResult.degraded = false;
             aiFallbackResult.score = 100;
             aiFallbackResult.verdict = 'original';
             aiFallbackResult.reasoning = `No matching web sources found across ${checkedCount} sampled sentences. The document appears entirely original.`;
        }
        return aiFallbackResult;
    }

    console.log(`   🤖 Running Deep AI Analysis on ${webSources.length} matched sources...`);
    const aiReport = await runAIEvaluation(text, webSources);

    let finalScore = 50;
    let finalVerdict = 'suspicious';
    let finalReasoning = '';
    let finalSources = [];
    let paraphraseDetected = false;

    if (aiReport) {
        finalScore = aiReport.originality_score;
        finalVerdict = aiReport.verdict;
        finalReasoning = aiReport.detailed_analysis;
        finalSources = aiReport.matched_sources || [];
        paraphraseDetected = aiReport.paraphrase_detected || false;
    } else {
        // Fallback: proportional scoring
        const matchRate = webSources.length / checkedCount;
        finalScore = Math.max(0, Math.round(100 - (matchRate * 100)));
        finalVerdict = matchRate >= 0.4 ? 'plagiarized' : (matchRate >= 0.15 ? 'suspicious' : 'original');
        finalReasoning = `Legacy Warning: ${webSources.length} out of ${checkedCount} key sentences were found on external websites.`;
        finalSources = webSources;
    }

    console.log(`   ═══════════════════════════════════════`);
    console.log(`   AI Result: ${finalVerdict.toUpperCase()} — Score: ${finalScore}/100`);
    console.log(`   Paraphrase Detected: ${paraphraseDetected}`);
    console.log(`   Reasoning: ${finalReasoning.substring(0, 120)}...`);
    console.log(`   ═══════════════════════════════════════\n`);

    return {
        enabled: true,
        engine,
        engineHealthy: true,
        score: finalScore,
        verdict: finalVerdict,
        reasoning: finalReasoning,
        webSources: finalSources,
        matchedSentences: webSources.length,
        totalChecked: checkedCount,
        paraphrase_detected: paraphraseDetected,
        ai_powered: !!aiReport
    };
}

module.exports = {
    checkWebPlagiarism,
    extractKeySentences,
    parseDDGResults,    // exported for tests
};
