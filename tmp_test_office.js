const officeParser = require('officeparser');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

async function test() {
    console.log("OfficeParser keys:", Object.keys(officeParser));
    
    // Test with a dummy buffer if possible, or just check the presence of methods
    if (typeof officeParser.parseOffice === 'function') {
        console.log("✅ parseOffice exists");
    } else {
        console.log("❌ parseOffice MISSING");
    }

    if (typeof officeParser.parseOfficeAsync === 'function') {
        console.log("✅ parseOfficeAsync exists");
    } else {
        console.log("❌ parseOfficeAsync MISSING");
    }
}

test().catch(console.error);
