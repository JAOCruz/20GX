// process-replay.js
// Punto de entrada: recibe un .slp (o una carpeta con varios) y corre
// todo el pipeline: detectar highlights -> cortar clips -> subir a
// Discord para revision.
//
// Uso:
//   DISCORD_WEBHOOK_URL=... SSBM_ISO_PATH=... SLIPPI_DOLPHIN_PATH=... \
//   node process-replay.js /ruta/a/partida.slp
//
//   o para una carpeta completa de VODs de una sesion:
//   node process-replay.js /ruta/a/carpeta_de_replays/

const fs = require('fs');
const path = require('path');
const { detectHighlights } = require('./detect-highlights');
const { cutAllClips } = require('./cut-clips');
const { postClipsForReview } = require('./post-to-discord');

async function processFile(slpPath, webhookUrl) {
  console.log(`\n=== Procesando ${slpPath} ===`);

  const highlights = detectHighlights(slpPath);
  if (highlights.length === 0) {
    console.log('[process-replay] No se encontraron highlights en este replay.');
    return;
  }
  console.log(`[process-replay] ${highlights.length} highlight(s) detectado(s).`);

  const clips = cutAllClips(slpPath, highlights);

  if (webhookUrl) {
    await postClipsForReview(webhookUrl, clips);
  } else {
    console.log('[process-replay] DISCORD_WEBHOOK_URL no definido, clips guardados localmente en:', clips.map(c => c.file));
  }
}

async function main() {
  const inputPath = process.argv[2];
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (!inputPath) {
    console.error('Uso: node process-replay.js <archivo.slp | carpeta>');
    process.exit(1);
  }

  const stat = fs.statSync(inputPath);

  if (stat.isDirectory()) {
    const files = fs
      .readdirSync(inputPath)
      .filter((f) => f.endsWith('.slp'))
      .map((f) => path.join(inputPath, f));

    console.log(`[process-replay] ${files.length} archivo(s) .slp encontrados en la carpeta.`);

    for (const file of files) {
      await processFile(file, webhookUrl);
    }
  } else {
    await processFile(inputPath, webhookUrl);
  }
}

main().catch((err) => {
  console.error('[process-replay] Error:', err);
  process.exit(1);
});
