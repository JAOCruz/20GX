#!/bin/bash
# setup-mac.sh
# Instala el pipeline de highlights de Slippi directamente en tu Mac M3.
# Uso: guarda este archivo en ~/Desktop/setup-mac.sh, abre Terminal y corre:
#   bash ~/Desktop/setup-mac.sh

set -e

PIPELINE_DIR="$HOME/slippi-pipeline"
CLIPS_DIR="$PIPELINE_DIR/clips"
REPLAYS_DIR="$PIPELINE_DIR/replays"

# Rutas tipicas en Mac - ajusta si las tienes en otro lado
MELEE_ISO="${SSBM_ISO_PATH:-$HOME/Melee/Super Smash Bros. Melee (USA) (En,Ja) (Rev 2).iso}"
SLIPPI_DOLPHIN="${SLIPPI_DOLPHIN_PATH:-$HOME/Library/Application Support/Slippi Launcher/playback/Slippi Dolphin.app}"

mkdir -p "$PIPELINE_DIR"
mkdir -p "$CLIPS_DIR"
mkdir -p "$REPLAYS_DIR"

cd "$PIPELINE_DIR"

echo "[setup] Verificando dependencias..."
if ! command -v node &> /dev/null; then
  echo "[setup] Node.js no encontrado. Instalando con brew..."
  brew install node
fi
if ! command -v ffmpeg &> /dev/null; then
  echo "[setup] ffmpeg no encontrado. Instalando con brew..."
  brew install ffmpeg
fi

echo "[setup] Instalando slp-to-video..."
if [ ! -d "$PIPELINE_DIR/slp-to-video" ]; then
  git clone https://github.com/MiguelTornero/slp-to-video.git
  cd slp-to-video
  npm install
  cd ..
fi

echo "[setup] Creando archivos del pipeline..."

cat > package.json << 'EOF'
{
  "name": "slippi-highlight-pipeline",
  "version": "1.0.0",
  "description": "Detecta highlights en replays de Slippi, los corta en clips y los sube a Discord para revision antes de publicar en YouTube.",
  "main": "batch-process.js",
  "scripts": {
    "process": "node batch-process.js"
  },
  "dependencies": {
    "@slippi/slippi-js": "^6.13.2"
  },
  "engines": {
    "node": ">=18"
  }
}
EOF

cat > detect-highlights.js << 'EOF'
const { SlippiGame } = require('@slippi/slippi-js');

const FPS = 60;
const PADDING_SECONDS_BEFORE = 2.0;
const PADDING_SECONDS_AFTER = 2.0;
const MIN_MOVES_FOR_HIGHLIGHT = 4;
const TARGET_PLAYER_NAMES = ['HARD', 'JIMY'];

function normalizeName(s) {
  if (!s || typeof s !== 'string') return '';
  return s.trim().toUpperCase();
}

function isTargetPlayer(player) {
  if (!player) return false;
  const names = [
    normalizeName(player.connectCode),
    normalizeName(player.nametag),
    normalizeName(player.displayName),
  ];
  return TARGET_PLAYER_NAMES.some((target) => names.some((n) => n.includes(target)));
}

function findStockLossFrame(game, victimIndex, fromFrame, toFrame) {
  try {
    const frames = game.getFrames();
    let previousStocks = null;
    for (let f = fromFrame; f <= toFrame; f++) {
      const frame = frames[f];
      if (!frame || !frame.players || !frame.players[victimIndex]) continue;
      const post = frame.players[victimIndex].post;
      if (post == null || typeof post.stocks !== 'number') continue;
      if (previousStocks !== null && post.stocks < previousStocks) {
        return f;
      }
      previousStocks = post.stocks;
    }
  } catch (e) {
    console.warn('[detect-highlights] Error buscando stock loss:', e.message);
  }
  return null;
}

function detectHighlights(slpPath) {
  const game = new SlippiGame(slpPath);
  const settings = game.getSettings();
  const stats = game.getStats();

  if (!stats || !stats.combos) {
    console.warn(`[detect-highlights] No se pudieron leer stats de ${slpPath}`);
    return [];
  }

  const startFrame = settings.startFrame ?? -123;
  const lastFrame = settings.lastFrame ?? stats.lastFrame ?? Infinity;

  const rawWindows = stats.combos
    .filter((combo) => {
      if (combo.moves.length < MIN_MOVES_FOR_HIGHLIGHT) return false;
      const aggressorIndex = combo.moves[0]?.playerIndex ?? combo.lastHitBy;
      const aggressor = settings.players.find((p) => p.playerIndex === aggressorIndex);
      return isTargetPlayer(aggressor);
    })
    .map((combo) => {
      const aggressorIndex = combo.moves[0]?.playerIndex ?? combo.lastHitBy;
      const victimIndex = combo.playerIndex;
      const aggressor = settings.players.find((p) => p.playerIndex === aggressorIndex);
      const victim = settings.players.find((p) => p.playerIndex === victimIndex);

      const padBefore = Math.round(PADDING_SECONDS_BEFORE * FPS);
      const padAfter = Math.round(PADDING_SECONDS_AFTER * FPS);

      const searchEnd = Math.min(lastFrame, combo.endFrame + FPS * 5);
      const stockLossFrame = combo.didKill
        ? findStockLossFrame(game, victimIndex, combo.startFrame, searchEnd)
        : null;

      const endFrame = stockLossFrame !== null
        ? stockLossFrame + padAfter
        : combo.endFrame + padAfter;

      const attackerName =
        aggressor?.nametag || aggressor?.connectCode || `P${aggressorIndex + 1}`;
      const victimName =
        victim?.nametag || victim?.connectCode || `P${victimIndex + 1}`;

      return {
        startFrame: Math.max(startFrame, combo.startFrame - padBefore),
        endFrame,
        playerIndex: aggressorIndex,
        reason: stockLossFrame !== null
          ? `${attackerName} mata a ${victimName} (${combo.moves.length} golpes)`
          : `${attackerName} combo a ${victimName} (${combo.moves.length} golpes)`,
      };
    })
    .sort((a, b) => a.startFrame - b.startFrame);

  const merged = [];
  const MERGE_GAP_FRAMES = FPS * 1;

  for (const win of rawWindows) {
    const last = merged[merged.length - 1];
    if (last && win.startFrame - last.endFrame <= MERGE_GAP_FRAMES) {
      last.endFrame = Math.max(last.endFrame, win.endFrame);
      last.reason += ` + ${win.reason}`;
    } else {
      merged.push({ ...win });
    }
  }

  return merged;
}

module.exports = { detectHighlights, isTargetPlayer };

if (require.main === module) {
  const slpPath = process.argv[2];
  if (!slpPath) {
    console.error('Uso: node detect-highlights.js <archivo.slp>');
    process.exit(1);
  }
  const highlights = detectHighlights(slpPath);
  console.log(JSON.stringify(highlights, null, 2));
}
EOF

cat > cut-clips.js << 'EOF'
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CONFIG = {
  sltVideoBin: process.env.SLP_TO_VIDEO_BIN || 'slp-to-video',
  dolphinPath: process.env.SLIPPI_DOLPHIN_PATH,
  isoPath: process.env.SSBM_ISO_PATH,
  ffmpegPath: process.env.FFMPEG_PATH,
  outputDir: process.env.CLIPS_OUTPUT_DIR || path.join(__dirname, 'clips'),
};

function ensureOutputDir() {
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
}

function cutClip(slpPath, highlight, clipName) {
  ensureOutputDir();
  const outputFile = path.join(CONFIG.outputDir, `${clipName}.mp4`);

  const args = [
    slpPath,
    '-o', outputFile,
    '-f', String(highlight.startFrame),
    '-t', String(highlight.endFrame),
  ];

  if (CONFIG.isoPath) args.push('-i', CONFIG.isoPath);
  if (CONFIG.dolphinPath) args.push('-d', CONFIG.dolphinPath);
  if (CONFIG.ffmpegPath) args.push('-p', CONFIG.ffmpegPath);

  console.log(`[cut-clips] Cortando ${clipName}: frames ${highlight.startFrame}-${highlight.endFrame}`);
  execFileSync(CONFIG.sltVideoBin, args, { stdio: 'inherit' });
  return outputFile;
}

function cutAllClips(slpPath, highlights) {
  const baseName = path.basename(slpPath, '.slp');
  return highlights.map((highlight, idx) => {
    const clipName = `${baseName}_clip${idx + 1}`;
    const file = cutClip(slpPath, highlight, clipName);
    return { file, ...highlight };
  });
}

module.exports = { cutClip, cutAllClips, CONFIG };
EOF

cat > post-to-discord.js << 'EOF'
const fs = require('fs');

async function postClipsForReview(webhookUrl, clips) {
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const form = new FormData();

    const content =
      `**Highlight ${i + 1}** — ${clip.reason}\n` +
      `Frames ${clip.startFrame}-${clip.endFrame} (~${((clip.endFrame - clip.startFrame) / 60).toFixed(1)}s)\n` +
      `Reacciona con ✅ para aprobar la subida a YouTube.`;

    form.append('payload_json', JSON.stringify({ content }));
    form.append(
      'file',
      new Blob([fs.readFileSync(clip.file)], { type: 'video/mp4' }),
      clip.file.split('/').pop()
    );

    const res = await fetch(webhookUrl, { method: 'POST', body: form });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Discord respondio ${res.status}: ${text}`);
    }

    console.log(`[post-to-discord] Subido: ${clip.file}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

module.exports = { postClipsForReview };
EOF

cat > replace-audio.js << 'EOF'
const { execFileSync } = require('child_process');
const fs = require('fs');

function replaceAudio(inputFile, musicFile, outputFile) {
  if (!fs.existsSync(musicFile)) {
    throw new Error(`No se encontro la pista de musica: ${musicFile}`);
  }

  const args = [
    '-y',
    '-i', inputFile,
    '-stream_loop', '-1', '-i', musicFile,
    '-filter_complex',
    '[1:a]volume=0.12,afade=t=out:st=0:d=2[bg];[0:a]volume=1.0[game];[game][bg]amix=inputs=2:duration=first[aout]',
    '-map', '0:v:0',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    outputFile,
  ];

  execFileSync('ffmpeg', args, { stdio: 'inherit' });
  return outputFile;
}

module.exports = { replaceAudio };
EOF

cat > batch-process.js << 'EOF'
const fs = require('fs');
const path = require('path');
const { detectHighlights } = require('./detect-highlights');
const { cutAllClips } = require('./cut-clips');
const { postClipsForReview } = require('./post-to-discord');
const { replaceAudio } = require('./replace-audio');

const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '1', 10));
const MUSIC_TRACK = process.env.MUSIC_TRACK || null;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

function findSlpFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSlpFiles(fullPath));
    } else if (entry.name.endsWith('.slp')) {
      results.push(fullPath);
    }
  }
  return results;
}

function filterRecent(files, monthsBack = 2) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsBack);
  return files.filter((f) => {
    const stat = fs.statSync(f);
    return stat.mtime >= cutoff;
  });
}

async function runWithConcurrency(jobs, concurrency) {
  const results = [];
  const executing = new Set();
  for (const [index, job] of jobs.entries()) {
    const promise = job().then((result) => {
      results[index] = result;
      executing.delete(promise);
      return result;
    });
    results[index] = null;
    executing.add(promise);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  return results;
}

async function main() {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    console.error('Uso: node batch-process.js <carpeta1> [carpeta2] ...');
    process.exit(1);
  }

  let allFiles = [];
  for (const input of inputs) {
    if (!fs.existsSync(input)) {
      console.warn(`[batch] Ruta no encontrada: ${input}`);
      continue;
    }
    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
      allFiles.push(...findSlpFiles(input));
    } else if (input.endsWith('.slp')) {
      allFiles.push(input);
    }
  }

  const recentFiles = filterRecent(allFiles, 2);
  console.log(`[batch] ${recentFiles.length} replays de los ultimos 2 meses.`);
  if (recentFiles.length === 0) return;

  console.log('[batch] Fase 1: detectando highlights...');
  const highlightsByFile = await runWithConcurrency(
    recentFiles.map((slpPath) => () => {
      try {
        const highlights = detectHighlights(slpPath);
        return { slpPath, highlights };
      } catch (e) {
        console.error(`[batch] Error analizando ${slpPath}:`, e.message);
        return { slpPath, highlights: [] };
      }
    }),
    Math.min(4, recentFiles.length)
  );

  const filesWithHighlights = highlightsByFile.filter((x) => x.highlights.length > 0);
  const totalHighlights = filesWithHighlights.reduce((sum, x) => sum + x.highlights.length, 0);
  console.log(`[batch] ${filesWithHighlights.length} replays con highlights, ${totalHighlights} clips.`);

  console.log(`[batch] Fase 2: renderizando 1 replay a la vez...`);
  const allClips = [];

  for (const { slpPath, highlights } of filesWithHighlights) {
    try {
      const clips = cutAllClips(slpPath, highlights);
      for (const clip of clips) {
        let finalFile = clip.file;
        if (MUSIC_TRACK && fs.existsSync(MUSIC_TRACK)) {
          const musicOutput = clip.file.replace('.mp4', '_music.mp4');
          console.log(`[batch] Reemplazando audio: ${path.basename(musicOutput)}`);
          replaceAudio(clip.file, MUSIC_TRACK, musicOutput);
          finalFile = musicOutput;
        }
        allClips.push({ ...clip, file: finalFile });
      }
    } catch (e) {
      console.error(`[batch] Error renderizando ${slpPath}:`, e.message);
    }
  }

  if (DISCORD_WEBHOOK_URL && allClips.length > 0) {
    console.log(`[batch] Fase 3: subiendo ${allClips.length} clip(s) a Discord...`);
    await postClipsForReview(DISCORD_WEBHOOK_URL, allClips);
  }

  console.log(`\n[batch] Listo. ${allClips.length} clip(s) en: ${path.resolve(process.env.CLIPS_OUTPUT_DIR || path.join(__dirname, 'clips'))}`);
}

main().catch((err) => {
  console.error('[batch] Error fatal:', err);
  process.exit(1);
});
EOF

cat > upload-to-youtube.js << 'EOF'
const { chromium } = require('playwright');
const fs = require('fs');

const COOKIES_PATH = process.env.YT_COOKIES_PATH || './youtube-cookies.json';
const THUMBNAIL_PATH = process.env.YT_THUMBNAIL_PATH || null;

async function uploadToYouTube(videoPath, title, description) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  if (fs.existsSync(COOKIES_PATH)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    await context.addCookies(cookies);
  }

  const page = await context.newPage();
  try {
    await page.goto('https://studio.youtube.com/channel/videos/upload');
    const fileInput = await page.locator('input[type=file]');
    await fileInput.setInputFiles(videoPath);

    await page.fill('input#textbox[aria-label="Title (required)"]', title);
    await page.fill('textbox#textbox[aria-label="Tell viewers about your video"]', description);

    await page.waitForFunction(
      () => document.body.innerText.includes('Processing will begin shortly'),
      { timeout: 300000 }
    );

    if (THUMBNAIL_PATH) {
      const thumbInput = await page.locator('input[type=file]').nth(1);
      await thumbInput.setInputFiles(THUMBNAIL_PATH);
    }

    const cookies = await context.cookies();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    console.log('[youtube] Subida completada.');
  } catch (e) {
    console.error('[youtube] Error:', e.message);
    throw e;
  } finally {
    await browser.close();
  }
}

async function main() {
  const [videoPath, title, description] = process.argv.slice(2);
  if (!videoPath || !title) {
    console.error('Uso: node upload-to-youtube.js <clip.mp4> "Titulo" "Descripcion"');
    process.exit(1);
  }
  await uploadToYouTube(videoPath, title, description || '');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
EOF

echo "[setup] Instalando dependencias npm..."
npm install

echo ""
echo "===== Setup completo ====="
echo "Directorio: $PIPELINE_DIR"
echo ""
echo "Ajusta estas rutas si son diferentes:"
echo "  ISO:  $MELEE_ISO"
echo "  Dolphin: $SLIPPI_DOLPHIN"
echo ""
echo "Ejemplo de uso (solo clips locales):"
echo "  cd $PIPELINE_DIR"
echo "  SSBM_ISO_PATH=\"$MELEE_ISO\" SLIPPI_DOLPHIN_PATH=\"$SLIPPI_DOLPHIN\" node batch-process.js /Users/jay/Slippi"
echo ""
echo "Con musica de fondo:"
echo "  MUSIC_TRACK=/ruta/a/musica.mp3 SSBM_ISO_PATH=\"$MELEE_ISO\" SLIPPI_DOLPHIN_PATH=\"$SLIPPI_DOLPHIN\" node batch-process.js /Users/jay/Slippi"
echo ""
echo "Con Discord:"
echo "  DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... SSBM_ISO_PATH=\"$MELEE_ISO\" SLIPPI_DOLPHIN_PATH=\"$SLIPPI_DOLPHIN\" node batch-process.js /Users/jay/Slippi"
