// preview-render.js
// Previews MP4 livianos de un stock/momento para el dashboard: baja calidad,
// muteados, pensados para cargar rápido en el player web.
//
// Pipeline: Dolphin headless (vía cut-clips.js / slp-to-video) a resolución
// interna 1x + transcode ffmpeg final (max 854x480, sin audio, h264 crf 30
// preset veryfast, faststart). Resulta ~3-4x más rápido que el render final.
//
// Cache en previews/: key = sha1(gamePath|startFrame|endFrame). Si el mp4 ya
// existe se devuelve sin re-renderizar. Los jobs 'preview' corren en la cola
// SQLite (worker-server.js), que es estrictamente secuencial: nunca dos
// Dolphin/ffmpeg en paralelo.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { cutClipAsync } = require('./cut-clips');

const PREVIEWS_DIR = path.join(__dirname, 'previews');
const INDEX_FILE = path.join(PREVIEWS_DIR, 'index.json');

function log(...args) {
  console.log(`[preview-render] ${new Date().toISOString()}`, ...args);
}

// Id determinístico del preview: mismo juego + mismos frames = mismo archivo.
function previewIdFor(gamePath, startFrame, endFrame) {
  const hash = crypto
    .createHash('sha1')
    .update(`${path.resolve(gamePath)}|${startFrame}|${endFrame}`)
    .digest('hex')
    .slice(0, 16);
  return `pv-${hash}`;
}

function previewFilePath(id) {
  return path.join(PREVIEWS_DIR, `${id}.mp4`);
}

function getCachedPath(id) {
  const filePath = previewFilePath(id);
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0 ? filePath : null;
}

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    log('Index corrupto, ignorando:', e.message);
    return {};
  }
}

function saveIndex(index) {
  const tmp = `${INDEX_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, INDEX_FILE);
}

function registerPreview(entry) {
  const index = loadIndex();
  index[entry.id] = { ...index[entry.id], ...entry };
  saveIndex(index);
  return index[entry.id];
}

function getPreview(id) {
  return loadIndex()[id] || null;
}

function listPreviews(gamePath) {
  const all = Object.values(loadIndex());
  const filtered = gamePath
    ? all.filter((p) => p.gamePath === gamePath)
    : all;
  return filtered
    .map((p) => ({ ...p, cached: !!getCachedPath(p.id) }))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// Transcode final: max 854x480 manteniendo aspecto, sin audio, liviano.
function transcodePreview(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', inputPath,
      '-vf', "scale=854:480:force_original_aspect_ratio=decrease,setsar=1",
      '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
      '-movflags', '+faststart',
      outputPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        resolve(outputPath);
      } else {
        reject(new Error(`ffmpeg preview salió con código ${code}: ${stderr.slice(-300)}`));
      }
    });
  });
}

/**
 * Ejecuta un job 'preview' de la cola.
 * payload: { id, gamePath, startFrame, endFrame }
 * @returns {{ id, filePath, cached, sizeBytes, elapsedSeconds }}
 */
async function runPreviewJob(job, queue) {
  const { id, gamePath, startFrame, endFrame } = job.payload;
  if (!id || !gamePath) throw new Error('Job preview sin id/gamePath');

  // Doble check por si otro job ya lo renderizó mientras éste esperaba.
  const cached = getCachedPath(id);
  if (cached) {
    log('Preview ya cacheado, skip render:', id);
    return { id, filePath: cached, cached: true, sizeBytes: fs.statSync(cached).size, elapsedSeconds: 0 };
  }

  const startedAt = Date.now();
  const tempDir = path.join(PREVIEWS_DIR, `.tmp-${id}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    if (queue) queue.updateProgress(job.id, { phase: 'render', id });
    log(`Render preview ${id}: ${path.basename(gamePath)} frames ${startFrame}-${endFrame}`);

    // Dolphin a resolución interna 1x (nativa ~640x480), bitrate bajo: el
    // transcode final manda. Timeout menor que un render final (son segundos
    // de footage a 1x, mucho más rápido).
    const { promise } = cutClipAsync(
      gamePath,
      { startFrame, endFrame, reason: `preview ${id}` },
      `${id}-raw`,
      { resolution: '1x', bitrate: 4000, timeoutMs: 8 * 60 * 1000 },
      tempDir
    );
    const rawFile = await promise;

    if (queue) queue.updateProgress(job.id, { phase: 'encode', id });
    const outputPath = previewFilePath(id);
    await transcodePreview(rawFile, outputPath);

    const sizeBytes = fs.statSync(outputPath).size;
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    registerPreview({
      id,
      gamePath,
      startFrame,
      endFrame,
      fileName: path.basename(outputPath),
      status: 'done',
      createdAt: new Date().toISOString(),
    });
    log(`Preview listo: ${id} (${(sizeBytes / 1024).toFixed(0)} KB, ${elapsedSeconds}s)`);
    return { id, filePath: outputPath, cached: false, sizeBytes, elapsedSeconds };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      log('No se pudo limpiar temp dir:', e.message);
    }
  }
}

module.exports = {
  PREVIEWS_DIR,
  previewIdFor,
  previewFilePath,
  getCachedPath,
  registerPreview,
  getPreview,
  listPreviews,
  runPreviewJob,
};
