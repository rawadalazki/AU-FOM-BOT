// Check if the Arabic text at line 2210 is actually valid UTF-8 double-encoded or proper UTF-8
const fs = require('fs');
const buf = fs.readFileSync('bot-manager.js');

// Find line 2210
let lineNum = 1;
let pos = 0;
for (let i = 0; i < buf.length; i++) {
  if (buf[i] === 0x0A) {
    lineNum++;
    if (lineNum === 2210) {
      pos = i + 1;
      break;
    }
  }
}

// Extract bytes for lines 2210-2214
let end = pos;
let linesFound = 0;
for (let i = pos; i < buf.length; i++) {
  if (buf[i] === 0x0A) {
    linesFound++;
    if (linesFound >= 5) {
      end = i;
      break;
    }
  }
}

const slice = buf.slice(pos, end);
const text = slice.toString('utf8');
console.log('=== Lines 2210-2214 as UTF-8 ===');
console.log(text);

// Check if the Ø§ pattern means double-encoded UTF-8
// Ø§ in UTF-8 is C3 98 C2 A7 (which is U+00D8 U+00A7 = double-encoded Arabic ا)
const hexSample = [];
for (let i = 0; i < Math.min(100, slice.length); i++) {
  hexSample.push(slice[i].toString(16).padStart(2, '0'));
}
console.log('\n=== First 100 bytes hex ===');
console.log(hexSample.join(' '));

// Check if it's mojibake (double-encoded)
const testStr = 'Ø§Ù„Ø¨Ø¯Ø¡';
const testBuf = Buffer.from(testStr, 'utf8');
// Try decoding as latin1 then re-interpreting as utf8
const latin1 = testBuf.toString('latin1');
console.log('\n=== Double-decode test ===');
console.log('Original:', testStr);
try {
  const reinterpreted = Buffer.from(testStr, 'latin1').toString('utf8');
  console.log('Re-interpreted:', reinterpreted);
} catch(e) {
  console.log('Re-interpretation failed:', e.message);
}

// Check the actual bytes at those positions
console.log('\n=== Checking if file has BOM or encoding issues ===');
console.log('First 3 bytes:', buf[0].toString(16), buf[1].toString(16), buf[2].toString(16));
