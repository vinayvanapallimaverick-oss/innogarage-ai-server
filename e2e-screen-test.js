// End-to-end test: login -> screen-analyze -> verify suggestions flow
const http = require('http');
const zlib = require('zlib');
const { PrismaClient } = require('@prisma/client');

// Generate a proper valid PNG programmatically
function createValidPng(width, height) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([len, typeAndData, crc]);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const o = 1 + x * 3;
      row[o] = (x * 255 / width) | 0;
      row[o + 1] = (y * 255 / height) | 0;
      row[o + 2] = 128;
    }
    rawRows.push(row);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rawRows))), chunk('IEND', Buffer.alloc(0))]);
}

function post(path, body, token) {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(body);
    const opts = {
      hostname: 'localhost', port: 3001, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) },
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject);
    req.write(b);
    req.end();
  });
}

(async () => {
  console.log('=== SCREEN ANALYSIS E2E TEST ===\n');

  // Step 1: Get auth token via OTP
  console.log('1. Logging in...');
  await post('/auth/login', { email: 'diag@x.com', password: 'Diag1234!' });
  await new Promise(r => setTimeout(r, 500));

  const db = new PrismaClient();
  const otp = await db.otpCode.findFirst({
    where: { user: { email: 'diag@x.com' }, used: false },
    orderBy: { createdAt: 'desc' },
  });
  await db.$disconnect();
  if (!otp) { console.error('FAIL: No OTP found'); return; }

  const otpRes = await post('/auth/verify-otp', { email: 'diag@x.com', code: otp.code });
  const otpData = JSON.parse(otpRes.body);
  const token = otpData.accessToken;
  if (!token) { console.error('FAIL: No token:', otpRes.body.substring(0, 200)); return; }
  console.log('   Token obtained ✓\n');

  // Step 2: Generate a proper valid test image
  const pngBuf = createValidPng(100, 100);
  const testImage = 'data:image/png;base64,' + pngBuf.toString('base64');

  console.log('2. Sending screen analysis request...');
  console.log('   Image size:', testImage.length, 'bytes');

  const startTime = Date.now();
  const result = await post('/interview/screen-analyze',
    { image: testImage, profile: { role: 'Software Engineer', interviewType: 'Technical' } },
    token
  );
  const elapsed = Date.now() - startTime;

  console.log('   Status:', result.status);
  console.log('   Content-Type:', result.headers['content-type']);
  console.log('   Response time:', elapsed, 'ms');
  console.log('   Body length:', result.body.length, 'chars\n');

  // Step 3: Parse SSE response
  if (result.headers['content-type']?.includes('text/event-stream')) {
    console.log('3. SSE stream received ✓');
    const lines = result.body.split('\n');
    let fullText = '';
    let chunks = 0;
    let hasError = false;

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      try {
        const p = JSON.parse(payload);
        if (p.text) { fullText += p.text; chunks++; }
        if (p.error) { console.error('   ERROR in stream:', p.error, p.detail || ''); hasError = true; }
      } catch {}
    }

    console.log('   Chunks received:', chunks);
    console.log('   Full text length:', fullText.length);
    console.log('   Text preview:', fullText.substring(0, 200));
    console.log('   Has error:', hasError);

    if (chunks > 0 && !hasError && fullText.length > 0) {
      console.log('\n=== TEST PASSED ✓ ===');
      console.log('The screen analysis pipeline works end-to-end.');
      console.log('Suggestions WILL appear in the UI when interview mode is active.');
    } else {
      console.log('\n=== TEST FAILED ✗ ===');
    }
  } else {
    console.log('3. UNEXPECTED response type:', result.headers['content-type']);
    console.log('   Body:', result.body.substring(0, 300));
    console.log('\n=== TEST FAILED ✗ ===');
  }
})();
