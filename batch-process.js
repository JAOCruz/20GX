// batch-process.js
// Procesa una carpeta (o varias) de replays de Slippi de forma controlada:
//   1. Encuentra todos los .slp.
//   2. Detecta highlights de forma ligera (sin Dolphin).
//   3. Renderiza los clips en cola secuencial (o con concurrencia limitada)
//      para no saturar el servidor.
//   4. Opcionalmente reemplaza el audio por musica de fondo.
//   5. Opcionalmente sube los clips a Discord para revision.
//
// Uso basico (procesa secuencialmente, guarda clips localmente):
//   SSBM_ISO_PATH=... SLIPPI_DOLPHIN_PATH=... \
//   node batch-process.js /ruta/a/replays
//
// Con 2 renders en paralelo:
//   CONCURRENCY=2 node batch-process.js /ruta/a/replays
//
// Con musica de fondo:
//   MUSIC_TRACK=/ruta/a/musica.mp3 node batch-process.js /ruta/a/replays
//
// Con Discord:
//   DISCORD_WEBHOOK_URL=... node batch-process.js /ruta/a/replays

const fs = require('fs');
const path = require('path');
const { detectHighlights } = require('./detect-highlights');
const { cutAllClips } = require('./cut-clips');
const { postClipsForReview } = require('./post-to-discord');
const { replaceAudio } = require('./replace-audio');
const { execFileSync } = require('child_process');

const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '1', 10));
const MUSIC_TRACK = process.env.MUSIC_TRACK || null;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;
const MAX_CLIPS = parseInt(process.env.MAX_CLIPS || '0', 10) || Infinity;

/**
 * Limpia procesos pesados que hayan quedado colgados de ejecuciones anteriores.
 */
function cleanupStaleProcesses() {
  try {
    execFileSync('pkill', ['-9', '-f', 'dolphin-emu'], { stdio: 'ignore' });
  } catch {}
  try {
    execFileSync('pkill', ['-9', '-f', 'Dolphin'], { stdio: 'ignore' });
  } catch {}
  try {
    execFileSync('pkill', ['-9', '-f', 'ffmpeg'], { stdio: 'ignore' });
  } catch {}
  try {
    execFileSync('pkill', ['-9', '-f', 'slp-to-video'], { stdio: 'ignore' });
  } catch {}
  console.log('[batch] Cleanup de procesos pesados completado.');
}

/**
 * Recorre recursivamente un directorio buscando .slp
 */
function findSlpFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSlpFiles(fullPath));
    } else if (entry.name.endsWith('.slp') && !entry.name.startsWith('._')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Filtra archivos por fecha de modificacion (ultimos N meses)
 */
function filterRecent(files, monthsBack = 2) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsBack);
  return files.filter((f) => {
    const stat = fs.statSync(f);
    return stat.mtime >= cutoff;
  });
}

/**
 * Procesa un solo replay: detectar, cortar clips, reemplazar audio, subir a Discord.
 */
async function processReplay(slpPath) {
  console.log(`\n[batch] Analizando ${path.basename(slpPath)}`);

  const highlights = detectHighlights(slpPath);
  if (highlights.length === 0) {
    console.log(`[batch] Sin highlights en ${path.basename(slpPath)}`);
    return [];
  }

  console.log(`[batch] ${highlights.length} highlight(s) detectado(s).`);
  const clips = cutAllClips(slpPath, highlights);

  const finalClips = [];
  for (const clip of clips) {
    let finalFile = clip.file;

    if (MUSIC_TRACK && fs.existsSync(MUSIC_TRACK)) {
      const musicOutput = clip.file.replace('.mp4', '_music.mp4');
      console.log(`[batch] Reemplazando audio: ${path.basename(musicOutput)}`);
      replaceAudio(clip.file, MUSIC_TRACK, musicOutput);
      finalFile = musicOutput;
    }

    finalClips.push({ ...clip, file: finalFile });
  }

  if (DISCORD_WEBHOOK_URL) {
    await postClipsForReview(DISCORD_WEBHOOK_URL, finalClips);
  }

  return finalClips;
}

/**
 * Ejecuta trabajos en paralelo limitado (cola controlada).
 */
async function runWithConcurrency(jobs, concurrency) {
  const results = [];
  const executing = new Set();

  for (const [index, job] of jobs.entries()) {
    const promise = Promise.resolve(job()).then((result) => {
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
  cleanupStaleProcesses();

  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    console.error('Uso: node batch-process.js <carpeta1> [carpeta2] ...');
    process.exit(1);
  }

  // Recolectar todos los .slp de los ultimos 2 meses
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
  console.log(`[batch] ${recentFiles.length} replays de los ultimos 2 meses encontrados.`);

  if (recentFiles.length === 0) {
    console.log('[batch] Nada que procesar.');
    return;
  }

  // Fase 1: deteccion ligera (sin Dolphin) - puede hacerse en paralelo
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
    Math.min(4, recentFiles.length) // deteccion es solo CPU, 4 en paralelo esta bien
  );

  let filesWithHighlights = highlightsByFile.filter((x) => x.highlights.length > 0);
  const totalHighlights = filesWithHighlights.reduce((sum, x) => sum + x.highlights.length, 0);

  console.log(`[batch] ${filesWithHighlights.length} replays con highlights, ${totalHighlights} clips totales.`);

  // Limitar cuantos clips renderizamos para no saturar el servidor
  if (MAX_CLIPS !== Infinity && totalHighlights > MAX_CLIPS) {
    console.log(`[batch] MAX_CLIPS=${MAX_CLIPS}. Seleccionando los primeros ${MAX_CLIPS} highlights.`);
    let kept = 0;
    filesWithHighlights = filesWithHighlights.filter((x) => {
      if (kept >= MAX_CLIPS) return false;
      kept += x.highlights.length;
      return true;
    });
  }

  // Fase 2: renderizado controlado (Dolphin es pesado)
  console.log(`[batch] Fase 2: renderizando clips con concurrencia ${CONCURRENCY}...`);
  const allClips = [];

  for (const { slpPath, highlights } of filesWithHighlights) {
    // Renderizamos todo un replay de golpe para no lanzar Dolphin multiples veces por archivo
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

  // Fase 3: subida a Discord (secuencial para respetar rate limits)
  if (DISCORD_WEBHOOK_URL && allClips.length > 0) {
    console.log(`[batch] Fase 3: subiendo ${allClips.length} clip(s) a Discord...`);
    await postClipsForReview(DISCORD_WEBHOOK_URL, allClips);
  }

  // Generar manifest y dashboard para el output
  if (allClips.length > 0) {
    const outputDir = path.resolve(process.env.CLIPS_OUTPUT_DIR || path.join(__dirname, 'clips'));
    const dashboardDir = path.join(__dirname, 'dashboard');

    const manifest = {
      generatedAt: new Date().toISOString(),
      clips: allClips.map((clip, idx) => ({
        id: `${path.basename(clip.file, '.mp4')}-${idx}`,
        file: path.basename(clip.file),
        reason: clip.reason,
        startFrame: clip.startFrame,
        endFrame: clip.endFrame,
        durationSeconds: (clip.endFrame - clip.startFrame) / 60,
      })),
    };
    fs.writeFileSync(
      path.join(outputDir, 'clips-manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    // Copiar dashboard al folder de clips para que funcione localmente
    if (fs.existsSync(dashboardDir)) {
      for (const f of ['index.html', 'app.js']) {
        const src = path.join(dashboardDir, f);
        const dst = path.join(outputDir, f);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dst);
        }
      }
    }

    console.log(`[batch] Manifest + dashboard guardados en: ${outputDir}`);
  }

  console.log(`\n[batch] Listo. ${allClips.length} clip(s) generado(s).`);
  console.log('[batch] Clips guardados en:', path.resolve(process.env.CLIPS_OUTPUT_DIR || path.join(__dirname, 'clips')));
}

main().catch((err) => {
  console.error('[batch] Error fatal:', err);
  process.exit(1);
});
