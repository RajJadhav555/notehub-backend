const { checkPlagiarism } = require('./src/utils/plagiarismChecker');

async function test() {
    try {
        console.log("Running plagiarism check...");
        const result = await checkPlagiarism("This is a test note for plagiarism check. It has enough words to barely pass the minimum requirement for checking. Hopefully it works without throwing the n.content error.");
        console.log("Result:", result.verdict ? "SUCCESS" : "FAILED", result);
    } catch (e) {
        console.error("Test failed with error:", e);
    } finally {
        // Need to close DB pool to exit
        const pool = require('./src/db');
        pool.end();
    }
}

test();
