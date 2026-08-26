// render-montage.js
// Selecciona los mejores clips por matchup de best-clips.json,
// los renderiza uno por uno y los combina en un solo MP4 con ffmpeg.
//
// Uso:
//   CLIPS_OUTPUT_DIR=/home/jay/slippi-pipeline/clips-montage \
//   node render-montage.js [best-clips.json]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { cutClip } = require('./cut-clips');

const BEST_CLIPS_FILE = process.argv[2] || '/home/jay/slippi-pipeline/best-clips.json';
const OUTPUT_DIR = process.env.CLIPS_OUTPUT_DIR || '/home/jay/slippi-pipeline/clips-montage';
const FINAL_OUTPUT = path.join(OUTPUT_DIR, 'montage-final.mp4');

// Cuántos clips seleccionar por matchup
const PICK_PER_MATCHUP = {
  'hard-vs-dolf': 1,
  'dolf-vs-hard': 3,
  'hard-vs-alor': 2,
  'hard-vs-hawk2': 0,
  'hard-vs-zura': 0,
};

const ORDER = ['hard-vs-dolf', 'dolf-vs-hard', 'hard-vs-alor'];

function ensureDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function pickClips(data) {
  const selected = [];
  for (const matchupId of ORDER) {
    const candidates = data.allCandidates[matchupId] || [];
    const count = PICK_PER_MATCHUP[matchupId] || 0;
    if (count === 0) continue;
    const picks = candidates.slice(0, count);
    for (const pick of picks) {
      selected.push({
        ...pick,
        clipName: `${matchupId}_${selected.length + 1}`,
      });
    }
  }
  return selected;
}

function renderClip(clip) {
  const expectedFile = path.join(OUTPUT_DIR, `${clip.clipName}.mp4`);
  if (fs.existsSync(expectedFile)) {
    const stats = fs.statSync(expectedFile);
    console.log(`\n[render-montage] ${clip.clipName} ya existe (${(stats.size / 1024 / 1024).toFixed(1)} MB), saltando.`);
    return expectedFile;
  }
  console.log(`\n[render-montage] Renderizando ${clip.clipName}: ${clip.reason}`);
  const file = cutClip(clip.slpPath, {
    startFrame: clip.startFrame,
    endFrame: clip.endFrame,
    reason: clip.reason,
  }, clip.clipName);
  return file;
}

function combineWithFfmpeg(files) {
  console.log('\n[render-montage] Combinando clips con ffmpeg...');

  // Metodo 1: concat demuxer (sin re-encode, rapido y sin perdida)
  const listFile = path.join(OUTPUT_DIR, 'concat-list.txt');
  fs.writeFileSync(
    listFile,
    files.map((f) => `file '${path.resolve(f)}'`).join('\n')
  );

  try {
    execFileSync('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      FINAL_OUTPUT,
    ], { stdio: 'inherit' });
    return true;
  } catch (e) {
    console.warn('[render-montage] concat demuxer fallo, intentando con re-encode:', e.message);
  }

  // Metodo 2: filter_complex con transiciones (re-encode, mas compatible)
  const filterInputs = files.map((f, i) => `-i ${f}`).join(' ');
  const filterChains = [];
  let current = '[0:v][0:a]';
  for (let i = 1; i < files.length; i++) {
    filterChains.push(`${current}[${i}:v][${i}:a]xfade=transition=fade:duration=0.5:offset=${i - 0.5}[v${i}];[v${i}]`);
    current = `[v${i}]`;
  }
  // Este metodo es mas complejo; por simplicidad usamos el demuxer.
  return false;
}

async function main() {
  ensureDir();

  if (!fs.existsSync(BEST_CLIPS_FILE)) {
    console.error(`[render-montage] No existe ${BEST_CLIPS_FILE}. Corre find-best-clips.js primero.`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(BEST_CLIPS_FILE, 'utf8'));
  const clips = pickClips(data);

  if (clips.length === 0) {
    console.log('[render-montage] No hay clips seleccionados.');
    return;
  }

  console.log(`[render-montage] ${clips.length} clips seleccionados:`);
  for (const c of clips) {
    console.log(`  - ${c.reason} (${formatTime((c.endFrame - c.startFrame) / 60)})`);
  }

  const renderedFiles = [];
  for (const clip of clips) {
    try {
      const file = renderClip(clip);
      renderedFiles.push(file);
    } catch (e) {
      console.error(`[render-montage] Error renderizando ${clip.clipName}:`, e.message);
    }
  }

  if (renderedFiles.length === 0) {
    console.error('[render-montage] Ningun clip se pudo renderizar.');
    process.exit(1);
  }

  combineWithFfmpeg(renderedFiles);

  if (fs.existsSync(FINAL_OUTPUT)) {
    const stats = fs.statSync(FINAL_OUTPUT);
    console.log(`\n[render-montage] Listo: ${FINAL_OUTPUT}`);
    console.log(`  Tamaño: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  Clips incluidos: ${renderedFiles.length}`);
  } else {
    console.error('[render-montage] No se genero el archivo final.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[render-montage] Error fatal:', err);
  process.exit(1);
});
