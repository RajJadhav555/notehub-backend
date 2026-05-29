const { OAuth2Client } = require('google-auth-library');
const CLIENT_ID = '1091785937553-9tt7ut2hsslcu6q816h145uq1p0ceecq.apps.googleusercontent.com';
const client = new OAuth2Client(CLIENT_ID);

const token = "eyJhbGciOiJSUzI1NiIsImtpZCI6IjRiYTZlZmVmNWUxNzIxNDk5NzFhMmQzYWJiNWYzMzJlMGY3ODcxNjUiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJhenAiOiIxMDkxNzg1OTM3NTUzLTl0dDd1dDJoc3NsY3U2cTgxNmgxNDV1cTFwMGNlZWNxLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29tIiwiYXVkIjoiMTA5MTc4NTkzNzU1My05dHQ3dXQyaHNzbGN1NnE4MTZoMTQ1dXExcDBjZWVjcS5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbSIsInN1YiI6IjExNTQyMjM1OTU0MDIxODAwMjg2OCIsImVtYWlsIjoiYXRoYXJ2YWphZGhhdjU1NTBAZ21haWwuY29tIiwiZW1haWxfdmVyaWZpZWQiOnRydWUsIm5iZiI6MTc2Nzk2ODE5NSwibmFtZSI6IkF0aGFydmEgSmFkaGF2IiwicGljdHVyZSI6Imh0dHBzOi8vbGgzLmdvb2dsZXVzZXJjb250ZW50LmNvbS9hL0FDZzhvY0w4NjVPQ19zM3dvdkUycTJqY3pvY1dTeG1OMzFhZk9DcERlOHpfTDBEd0x0NXRmZz1zOTYtYyIsImdpdmVuX25hbWUiOiJBdGhhcnZhIiwiZmFtaWx5X25hbWUiOiJKYWRoYXYiLCJpYXQiOjE3Njc5Njg0OTUsImV4cCI6MTc2Nzk3MjA5NSwianRpIjoiYWViY2Q1OTU3MWVmYmNjNjBlOTFhY2ZmMjJjYTA5ZDI3ZjhkYWQ5YiJ9.OTBPQZRBFxh5hbCk8sg6z8C1cBq-2fRAGZ_1YuCtotkMAlrfb64x1W2f5UQXgcMPxCGfsBYDRb4TCVxQNwrVFNiD9PRMSi_avwBFaVSEroxepqNyexbs_kF8CRJPeU-M1p1-R9TXweMZQEzYZFRpwH0m8bIqzlvOh36weqIFfXnqIWhgKfAlk46D9aGvpEeoxYbFmpJkBAN40ChAby19VDiLDaib5RokQLaEWVinNdUV95sbwib2Zj7jZlpMb3hqiWA3ToYxN6qroKKqI2_cNELXMdg5Djx7LHWykgMarl42EDpRHlv9jUBfv-MSz3bqiv7qon2-afYN92L-sn1vlg";

async function verify() {
    try {
        console.log("Current Server Time (Local):", new Date().toString());
        console.log("Current Server Time (ISO):", new Date().toISOString());
        
        console.log("\nVerifying token with maxClockSkew...");
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: CLIENT_ID,
            maxClockSkew: 22000 // Test if this fixes it locally
        });
        const payload = ticket.getPayload();
        console.log("✅ Token Valid with skew tolerance!");
        console.log("Payload nbf:", new Date(payload.nbf * 1000).toISOString());
    } catch (error) {
        console.error("❌ Standard Verification Failed:", error.message);
        
        if (error.message.includes('Token used too early')) {
            console.log("\n⚠️ Attempting Manual Verification with Tolerance...");
            const jwt = require('jsonwebtoken');
            
            // 1. Get Certs
            const certsResponse = await client.getFederatedSignonCertsAsync();
            const certs = certsResponse.certs;
            
            // 2. Decode to find KID
            const decoded = jwt.decode(token, { complete: true });
            if (!decoded) { console.error("Failed to decode token"); return; }
            const kid = decoded.header.kid;
            const cert = certs[kid];
            
            if (!cert) { console.error("Certificate not found for KID:", kid); return; }
            
            try {
                // 3. Verify Integrity (Signature) ignoring time
                const payload = jwt.verify(token, cert, { 
                    algorithms: ['RS256'],
                    audience: CLIENT_ID,
                    issuer: ['https://accounts.google.com', 'accounts.google.com'],
                    ignoreNotBefore: true,
                    ignoreExpiration: true
                });
                
                // 4. Manually check time with SAFE tolerance (22000 seconds)
                const now = Date.now() / 1000;
                const tolerance = 22000; 
                
                if (payload.nbf && (payload.nbf > now + tolerance)) {
                    throw new Error("Token used way too early (beyond tolerance)");
                }
                if (payload.exp && (payload.exp < now - tolerance)) {
                    throw new Error("Token expired (beyond tolerance)");
                }

                console.log("✅ MANUAL VERIFICATION SUCCESSFUL!");
                console.log("Payload:", payload);
            } catch (manualErr) {
                console.error("❌ Manual Verification Failed:", manualErr.message);
            }
        }
    }
}

verify();
