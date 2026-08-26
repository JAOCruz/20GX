const fs = require('fs');
const OpusEncoder = require('opusscript');

const input = process.argv[2];
const output = process.argv[3] || input.replace('.opus', '.wav');
const enc = new OpusEncoder(48000, 2);
const data = fs.readFileSync(input);
const pcmChunks = [];
let pos = 0;
let decodedPackets = 0;
let skipped = 0;

function createWavHeader(dataLength, sampleRate, channels, bitsPerSample) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

while (pos < data.length) {
  let found = false;
  for (let size = 3; size <= 250 && pos + size <= data.length; size++) {
    try {
      const packet = data.slice(pos, pos + size);
      const pcm = enc.decode(packet);
      if (pcm.length === 3840) {
        pcmChunks.push(pcm);
        pos += size;
        decodedPackets++;
        found = true;
        break;
      }
    } catch (e) {}
  }
  if (!found) {
    skipped++;
    pos++;
  }
}

const pcm = Buffer.concat(pcmChunks);
const header = createWavHeader(pcm.length, 48000, 2, 16);
fs.writeFileSync(output, Buffer.concat([header, pcm]));
console.log(`Decoded ${decodedPackets} packets, skipped ${skipped} bytes, output ${output}, duration ${pcm.length / (48000*2*2)}s`);
