// Direct OpenAI vision API test - isolate the issue
require('dotenv').config();
const OpenAI = require('openai');
const zlib = require('zlib');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Generate a proper valid PNG programmatically
function createValidPng(width, height) {
  // CRC32 implementation
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
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Raw image data: filter byte 0 + RGB for each pixel per row
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const offset = 1 + x * 3;
      row[offset] = (x * 255 / width) | 0;     // R
      row[offset + 1] = (y * 255 / height) | 0; // G
      row[offset + 2] = 128;                     // B
    }
    rawRows.push(row);
  }
  const raw = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pngBuffer = createValidPng(100, 100);
const PNG_BASE64 = pngBuffer.toString('base64');
console.log('Generated PNG size:', pngBuffer.length, 'bytes, base64 length:', PNG_BASE64.length);

async function testVision() {
  console.log('API Key prefix:', process.env.OPENAI_API_KEY?.substring(0, 15) + '...');
  
  // Test 1: Simple chat completion (no vision) - verify API key works
  console.log('\n--- Test 1: Basic chat completion ---');
  try {
    const res1 = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Say "hello" in one word.' }],
    });
    console.log('OK:', res1.choices[0].message.content);
  } catch (e) {
    console.error('FAILED:', e.message);
    return;
  }

  // Test 2: Vision with data URL
  console.log('\n--- Test 2: Vision with data:image/png;base64 ---');
  try {
    const res2 = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
          { type: 'text', text: 'What do you see?' },
        ],
      }],
    });
    console.log('OK:', res2.choices[0].message.content);
  } catch (e) {
    console.error('FAILED:', e.status, e.message);
  }

  // Test 3: Vision with detail:high
  console.log('\n--- Test 3: Vision with detail:high ---');
  try {
    const res3 = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}`, detail: 'high' } },
          { type: 'text', text: 'What do you see?' },
        ],
      }],
    });
    console.log('OK:', res3.choices[0].message.content);
  } catch (e) {
    console.error('FAILED:', e.status, e.message);
  }

  // Test 4: Vision with detail:low (less strict)
  console.log('\n--- Test 4: Vision with detail:low ---');
  try {
    const res4 = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}`, detail: 'low' } },
          { type: 'text', text: 'What do you see?' },
        ],
      }],
    });
    console.log('OK:', res4.choices[0].message.content);
  } catch (e) {
    console.error('FAILED:', e.status, e.message);
  }

  // Test 5: Streaming vision
  console.log('\n--- Test 5: Streaming vision ---');
  try {
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      stream: true,
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}`, detail: 'low' } },
          { type: 'text', text: 'Describe in 5 words.' },
        ],
      }],
    });
    let text = '';
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) text += delta;
    }
    console.log('OK:', text);
  } catch (e) {
    console.error('FAILED:', e.status, e.message);
  }
}

testVision().catch(e => console.error('Fatal:', e));
