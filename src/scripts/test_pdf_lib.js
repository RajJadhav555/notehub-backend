const pdf = require('pdf-parse');

async function test() {
  console.log("Loading PDF lib...");
  console.log("Type of pdf:", typeof pdf);
  console.log("pdf keys:", Object.keys(pdf || {}));
  try {
      // Mock random buffer
      const buffer = Buffer.from("%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n2 0 obj\n<<\n/Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>\nendobj\n3 0 obj\n<<\n/Type /Page\n/Parent 2 0 R\n/Resources <<\n/Font <<\n/F1 4 0 R\n>>\n>>\n/MediaBox [0 0 612 792]\n/Contents 5 0 R\n>>\nendobj\n4 0 obj\n<<\n/Type /Font\n/Subtype /Type1\n/Name /F1\n/BaseFont /Helvetica\n>>\nendobj\n5 0 obj\n<<\n/Length 44\n>>\nstream\nBT\n/F1 24 Tf\n100 100 Td\n(Hello World) Tj\nET\nendstream\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000010 00000 n \n0000000060 00000 n \n0000000157 00000 n \n0000000307 00000 n \n0000000410 00000 n \ntrailer\n<<\n/Size 6\n/Root 1 0 R\n>>\nstartxref\n492\n%%EOF\n");
      
      const data = await pdf(buffer);
      console.log(`Document Loaded. Info:`, data.info);
      console.log('Extracted:', data.text.substring(0, 100));
      console.log(`Document Loaded. Info:`, data.info);
      console.log('Extracted:', data.text.substring(0, 100));
      
  } catch (e) {
      console.error("Test Failed:", e);
  }
}

test();
