// render-continuous-final.js
// Renderiza un clip continuo del juego Game_20260712T160511.slp
// desde antes del frame 3176 (JIMY mata a DOLF) hasta el final del juego (5713)
// con audio de Discord retrasado 4.5s.

const fs = require('fs');
const path = require('path');
const { cutClip } = require('./cut-clips');
const { mixDiscordAudioForClip } = require('./discord-audio-sync');

const slpPath = '/home/jay/slippi-live/2026-07/Game_20260712T160511.slp';
const outputDir = process.env.CLIPS_OUTPUT_DIR || path.join(__dirname, 'clips-continuous-final');
const startFrame = 2756;
const endFrame = 5713;
const highlightFrame = 3176;
const leadSeconds = (highlightFrame - startFrame) / 60; // 7 segundos

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const clipName = `${path.basename(slpPath, '.slp')}_continuous_stock2toend`;
const baseFile = path.join(outputDir, `${clipName}.mp4`);

console.log(`[render-continuous] Renderizando frames ${startFrame}-${endFrame}`);
console.log(`[render-continuous] Highlight frame: ${highlightFrame}, leadSeconds: ${leadSeconds}`);

const rendered = cutClip(slpPath, {
  startFrame,
  endFrame,
  reason: 'continuous stock2 to game end',
}, clipName);

console.log('[render-continuous] Clip base:', rendered);

const mixedOutput = rendered.replace('.mp4', '_mixed.mp4');
const result = mixDiscordAudioForClip(slpPath, highlightFrame, rendered, mixedOutput, leadSeconds);

if (result.used) {
  fs.renameSync(mixedOutput, baseFile);
  console.log('[render-continuous] Clip final con audio de Discord:', baseFile);
} else {
  console.log('[render-continuous] Sin audio de Discord:', result.reason);
}
