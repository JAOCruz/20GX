// set-export.js
// Procesa jobs 'set-export' de la cola: renderiza sub-clips de forma
// ESTRICTAMENTE secuencial (invariante: nunca dos Dolphin/ffmpeg a la vez),
// los concatena con ffmpeg en compilations/ y notifica por Telegram.
//
// Tipos:
//   - full-set: items = juegos completos en orden del set.
//   - reel:     items = stocks seleccionados (gamePath + stockId).
//
// El flag `vertical` produce 1080x1920 pillarbox: el gameplay 4:3 entra
// completo (escalado a 1080 de ancho, bandas negras arriba/abajo, sin crop).

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { SlippiGame } = require('@slippi/slippi-js');
const { cutClipAsync } = require('./cut-clips');
const { patchSlpNametags } = require('./fix-nametags');
const { getGameStocks, LEAD_SECONDS, PAD_AFTER_SECONDS, CONTEXT_BEFORE_SECONDS } = require('./sets-stocks');
const { getSet, slugify } = require('./sets-store');
const { sendTextMessage, sendVideoMessage, escapeHtml } = require('./notify-telegram');
const approvals = require('./approvals');
const { generateMetadata, buildApprovalCaption } = require('./youtube-metadata');

const FPS = 60;
const COMPILATIONS_DIR = path.join(__dirname, 'compilations');
// Full-sets: resolución de render. '1x' (640x528, nativo Melee) rinde ~3x más
// rápido que 720p en este servidor y evita el killer de ~14 min (los chunks
// terminan antes). Subir a '720p' con FULL_SET_RESOLUTION si hace falta.
const FULL_SET_QUALITY = { resolution: process.env.FULL_SET_RESOLUTION || '1x' };
const TELEGRAM_TOKEN = process.env.SET_TELEGRAM_BOT_TOKEN || '8867205267:AAHcQE0j3Q-pYn2rbUdNRj9CkRFPvDyVodE';
const TELEGRAM_CHAT = process.env.SET_TELEGRAM_CHAT_ID || '6932565341';
const MAX_TELEGRAM_FULL_SET_BYTES = 1.5 * 1024 * 1024 * 1024; // ~1.5GB
const CLIP_INDEX_FILE = process.env.TELEGRAM_CLIP_INDEX || path.join(__dirname, 'telegram-clip-index.json');

// Limpieza de temp dirs clips-set-* viejos (>24h). Los de jobs fallidos se
// conservan para reanudar, pero no pueden quedarse para siempre en disco.
try {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const d of fs.readdirSync(__dirname)) {
    if (!d.startsWith('clips-set-')) continue;
    const full = path.join(__dirname, d);
    if (fs.statSync(full).isDirectory() && fs.statSync(full).mtimeMs < cutoff) {
      fs.rmSync(full, { recursive: true, force: true });
    }
  }
} catch (_) { /* ignore */ }

class CancelledError extends Error {
  constructor() {
    super('Job cancelado por el usuario');
    this.cancelled = true;
  }
}

function log(...args) {
  console.log(`[set-export] ${new Date().toISOString()}`, ...args);
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ¿El job fue cancelado mientras corría? (queue.cancel ahora también aplica a running)
function isCancelled(queue, jobId) {
  const fresh = queue.get(jobId);
  return !fresh || fresh.status === 'cancelled';
}

// Mata el child y todo su grupo de procesos (xvfb-run → node slp-to-video →
// Dolphin). Sin esto, cancelar dejaba Dolphins huérfanos renderizando (~800MB
// c/u) que se acumulaban y provocaban OOM en los renders siguientes.
function killTree(child) {
  const kill = (sig) => {
    try { process.kill(-child.pid, sig); } catch (e) {
      try { child.kill(sig); } catch (_) { /* ignore */ }
    }
  };
  kill('SIGTERM');
  setTimeout(() => kill('SIGKILL'), 3000);
}

// Duración real de un mp4 vía ffprobe (null si no se puede leer).
function ffprobeDurationSec(filePath) {
  try {
    const out = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ], { encoding: 'utf-8' });
    if (out.status !== 0) return null;
    const d = parseFloat(String(out.stdout).trim());
    return Number.isFinite(d) ? d : null;
  } catch (e) {
    return null;
  }
}

// Espera un child process matándolo si el job se cancela.
function waitCancellable(child, queue, jobId) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (isCancelled(queue, jobId)) {
        clearInterval(timer);
        killTree(child);
        reject(new CancelledError());
      }
    }, 2000);

    child.on('error', (err) => {
      clearInterval(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearInterval(timer);
      if (isCancelled(queue, jobId)) return reject(new CancelledError());
      if (code === 0) return resolve();
      // Muerte anómala (ej. SIGKILL externo): barrer posibles procesos
      // huérfanos del árbol (Dolphin/ffmpeg) para que no sigan escribiendo.
      killTree(child);
      reject(new Error(`proceso salió con código ${code}${signal ? ` (señal ${signal})` : ''}`));
    });
  });
}

function updateProgress(queue, jobId, progress) {
  try {
    queue.updateProgress(jobId, progress);
  } catch (e) {
    log('No se pudo actualizar progreso:', e.message);
  }
}

// Rango de frames de un juego completo.
function fullGameFrames(slpPath) {
  const game = new SlippiGame(slpPath);
  const settings = game.getSettings();
  const startFrame = settings.startFrame ?? -123;
  let endFrame = settings.lastFrame;
  if (typeof endFrame !== 'number') {
    endFrame = game.getLatestFrame()?.frame ?? 999999;
  }
  return { startFrame, endFrame };
}

// Rango de frames de un stock: el clip arranca en el INICIO del combo que mató
// (menos unos segundos de neutral como contexto), nunca a mitad del punish.
// Si no hay combo detectado (SD, kill suelto), cae al lead fijo antes del kill.
function stockFrames(slpPath, stockId, extraLeadSeconds = 0) {
  const data = getGameStocks(slpPath);
  const stock = data.stocks.find((s) => s.id === stockId);
  if (!stock) throw new Error(`Stock ${stockId} no encontrado en ${path.basename(slpPath)}`);
  const { startFrame, endFrame } = fullGameFrames(slpPath);
  const extraFrames = Math.round(Math.max(0, extraLeadSeconds) * FPS);
  const leadStart = stock.frame - Math.round(LEAD_SECONDS * FPS) - extraFrames;
  const comboStart = typeof stock.comboStartFrame === 'number'
    ? stock.comboStartFrame - Math.round(CONTEXT_BEFORE_SECONDS * FPS) - extraFrames
    : leadStart;
  return {
    startFrame: Math.max(startFrame, Math.min(leadStart, comboStart)),
    endFrame: Math.min(endFrame, stock.frame + Math.round(PAD_AFTER_SECONDS * FPS)),
  };
}

// Renderiza un sub-clip con cutClipAsync + watcher de cancelación.
async function renderSubClip(slpPath, frames, clipName, tempDir, queue, jobId, quality = {}) {
  const { promise, child } = cutClipAsync(
    slpPath,
    { startFrame: frames.startFrame, endFrame: frames.endFrame, reason: clipName },
    clipName,
    quality,
    tempDir
  );
  const watcher = waitCancellable(child, queue, jobId);
  // allSettled: si uno rechaza (ej. cancelación mata el child), el otro
  // igual termina sin provocar unhandled rejections.
  const [clipResult, watchResult] = await Promise.allSettled([promise, watcher]);
  if (watchResult.status === 'rejected') throw watchResult.reason;
  if (clipResult.status === 'rejected') throw clipResult.reason;
  return clipResult.value;
}

// Corre ffmpeg como child cancellable; rechaza si sale con error.
async function runFfmpeg(args, queue, jobId) {
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  try {
    await waitCancellable(child, queue, jobId);
  } catch (e) {
    if (stderr) e.message += ` — ${stderr.slice(-300)}`;
    throw e;
  }
}

// Info del stream de video vía ffprobe (null si no se puede leer).
function ffprobeVideoInfo(filePath) {
  try {
    const out = spawnSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,sample_aspect_ratio,codec_name',
      '-of', 'json', filePath,
    ], { encoding: 'utf-8' });
    if (out.status !== 0) return null;
    const s = JSON.parse(out.stdout).streams?.[0];
    return s ? { width: s.width, height: s.height, sar: s.sample_aspect_ratio, codec: s.codec_name } : null;
  } catch (e) {
    return null;
  }
}

// Concatena sub-clips en dos fases killer-safe (ningún proceso vive >15 min):
//  1) Normaliza CADA part a 1280x720 SAR 1:1 h264/aac en un ffmpeg propio
//     (~30s de video = <1 min por proceso). Resumible: los .norm.mp4 se reusan.
//  2) Concat final con -c copy (segundos) — solo válido porque tras la fase 1
//     todos los archivos comparten codec/resolución/parámetros.
// Antes esto era UN solo ffmpeg re-encodando los ~55 min completos: a los
// ~15 min el killer silencioso del servidor lo mataba y el job fallaba.
const DRAW_TEXT_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

// Filtro drawtext para el rótulo de capítulo ("Juego N - Stage") los primeros
// 6s del chunk. Texto sanitizado (drawtext rompe con ' : \ y comas).
// OJO: label vacío/undefined → null (sin overlay). Antes String(undefined)
// quemaba literalmente el texto "undefined" en los primeros 6s de cada clip
// de reel (los reels no tienen rótulos de capítulo).
function chapterOverlayFilter(label) {
  if (label == null || String(label).trim() === '') return null;
  if (!fs.existsSync(DRAW_TEXT_FONT)) return null;
  const safe = String(label).replace(/['\\:;,[\]%]/g, '').slice(0, 60);
  return `drawtext=fontfile=${DRAW_TEXT_FONT}:text='${safe}':fontsize=40:fontcolor=white:borderw=3:bordercolor=black@0.8:x=(w-text_w)/2:y=h-120:enable='lt(t,6)'`;
}

async function concatClips(files, outputPath, queue, jobId, chapterByClipName = {}) {
  const tempDir = path.dirname(files[0]);
  const normFiles = [];
  for (let i = 0; i < files.length; i++) {
    if (isCancelled(queue, jobId)) throw new CancelledError();
    const f = files[i];
    const clipName = path.basename(f, '.mp4');
    const info = ffprobeVideoInfo(f);
    if (info && info.codec === 'h264' && info.width === 1280 && info.height === 720 &&
        (info.sar === '1:1' || info.sar === 'N/A')) {
      normFiles.push(f);
      continue;
    }
    const normPath = path.join(tempDir, `${clipName}.norm.mp4`);
    if (fs.existsSync(normPath) && fs.statSync(normPath).size > 0 && ffprobeDurationSec(normPath) !== null) {
      normFiles.push(normPath);
      continue;
    }
    updateProgress(queue, jobId, { phase: 'normalize', current: i + 1, total: files.length, etaSec: null });
    let vf = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1';
    const chapterFilter = chapterOverlayFilter(chapterByClipName[clipName]);
    if (chapterFilter) vf += `,${chapterFilter}`;
    await runFfmpeg([
      '-y', '-loglevel', 'error', '-i', f,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '32000', '-ac', '2',
      normPath,
    ], queue, jobId);
    if (!fs.existsSync(normPath) || fs.statSync(normPath).size === 0) {
      throw new Error(`ffmpeg normalize no produjo salida para ${path.basename(f)}`);
    }
    normFiles.push(normPath);
  }

  const listFile = `${outputPath}.concat.txt`;
  fs.writeFileSync(listFile, normFiles.map((f) => `file '${f}'`).join('\n'));
  try {
    await runFfmpeg([
      '-y', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy', '-movflags', '+faststart',
      outputPath,
    ], queue, jobId);
  } finally {
    fs.rmSync(listFile, { force: true });
  }
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error('ffmpeg concat no produjo salida');
  }
  // Validación: la duración final debe cuadrar con la suma de los parts.
  const expectedSec = normFiles.reduce((acc, f) => acc + (ffprobeDurationSec(f) || 0), 0);
  const actualSec = ffprobeDurationSec(outputPath);
  if (actualSec === null || Math.abs(actualSec - expectedSec) > 10) {
    fs.rmSync(outputPath, { force: true });
    throw new Error(`concat truncado: ${actualSec}s vs ~${expectedSec}s esperados`);
  }
}

function cleanupTempDir(tempDir) {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (e) {
    log('No se pudo limpiar temp dir:', e.message);
  }
}

// Convierte el video a 1080x1920 vertical. Los parts vienen normalizados a
// 1280x720 con el gameplay 4:3 (642x528) centrado con bandas laterales —
// para vertical recortamos esas bandas primero (crop al aspecto del contenido)
// y así el gameplay queda PEGADO a los lados del Short, sin doble padding.
// Fondo (de mayor a menor prioridad):
//   1. assets/reel-bg.png (1080x1920) si existe — diseño personalizado.
//   2. Mismo video estirado y desenfocado (estilo Salt/PPMD) — default.
// Reescribe outputPath in-place (vía archivo temporal).
const REEL_BG_PATH = path.join(__dirname, 'assets', 'reel-bg.png');
// Aspecto del contenido renderizado por slp-to-video (642x528 nativo Melee).
const CONTENT_ASPECT = '642/528';
const CROP_CONTENT = `crop=w='floor(ih*${CONTENT_ASPECT}/2)*2':h=ih:x='(iw-ow)/2':y=0`;
// El gameplay cropeado se duplica: una copia llena 1080x1920 desenfocada
// (fondo), la otra va nítida al centro a ancho completo.
const BLUR_BG_FILTER =
  `[0:v]${CROP_CONTENT},split[bgs][fgs];` +
  `[bgs]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=15:2[bg];` +
  `[fgs]scale=1080:-2[fg];` +
  `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[out]`;

async function padToVertical(outputPath, queue, jobId) {
  const tmpPath = outputPath.replace(/\.mp4$/, '.vertical-tmp.mp4');
  const useBg = fs.existsSync(REEL_BG_PATH);
  const args = useBg
    ? [
        '-y', '-loglevel', 'error',
        '-i', outputPath,
        '-loop', '1', '-i', REEL_BG_PATH,
        '-filter_complex',
        `[0:v]${CROP_CONTENT},scale=1080:-2[game];[1:v][game]overlay=(W-w)/2:(H-h)/2,setsar=1[out]`,
        '-map', '[out]', '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
        tmpPath,
      ]
    : [
        '-y', '-loglevel', 'error', '-i', outputPath,
        '-filter_complex', BLUR_BG_FILTER,
        '-map', '[out]', '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-movflags', '+faststart',
        tmpPath,
      ];
  if (useBg) log('vertical: usando fondo personalizado assets/reel-bg.png');
  else log('vertical: fondo blurred (mismo video desenfocado)');
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  try {
    await waitCancellable(child, queue, jobId);
  } catch (e) {
    fs.rmSync(tmpPath, { force: true });
    throw e;
  }
  if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
    throw new Error(`ffmpeg vertical no produjo salida: ${stderr.slice(-300)}`);
  }
  fs.renameSync(tmpPath, outputPath);
}

function describeSet(set) {
  if (!set) return '';
  const [a, b] = set.players || [];
  const [wa, wb] = set.wins || [0, 0];
  const fmt = (p, w) => (p ? `${p.connectCode} (char ${p.characterId}): ${w}` : null);
  return [fmt(a, wa), fmt(b, wb)].filter(Boolean).join(' vs ');
}

/**
 * Ejecuta un job set-export. Lanza CancelledError si se cancela.
 * @returns {{ outputPath, outputUrl, fileName, sizeBytes, clipCount }}
 */
async function runSetExportJob(job, queue) {
  const { setId, name, type, items, vertical, leadSeconds } = job.payload;
  const set = setId ? getSet(setId) : null;
  const tempDir = path.join(__dirname, `clips-set-${job.id}`);
  fs.mkdirSync(tempDir, { recursive: true });
  if (!fs.existsSync(COMPILATIONS_DIR)) fs.mkdirSync(COMPILATIONS_DIR, { recursive: true });

  // Nametags vacíos = "undefined" quemado sobre el HUD en el video final.
  // Si el set tiene playerNames, renderizamos desde copias temporales
  // parcheadas (los .slp originales nunca se tocan).
  const patchedByGame = new Map();
  const renderPathFor = (gamePath) => {
    const names = set?.playerNames;
    if (!Array.isArray(names) || !names.some((n) => n && n.trim())) return gamePath;
    if (patchedByGame.has(gamePath)) return patchedByGame.get(gamePath);
    let out = gamePath;
    try {
      const players = new SlippiGame(gamePath).getSettings()?.players || [];
      const used = new Set();
      const namesByPort = {};
      players.forEach((p) => {
        if (p.nametag && p.nametag.trim()) return;
        const idx = (set.players || []).findIndex(
          (sp, i) => !used.has(i) && sp && sp.characterId === p.characterId
        );
        const name = idx >= 0 ? names[idx] : null;
        if (name && name.trim()) {
          used.add(idx);
          namesByPort[String(p.port)] = name.trim();
        }
      });
      if (Object.keys(namesByPort).length > 0) {
        out = path.join(tempDir, `patched-${patchedByGame.size}-${path.basename(gamePath)}`);
        patchSlpNametags(gamePath, out, namesByPort);
        log(`Nametags parcheados: ${path.basename(gamePath)} → ${Object.values(namesByPort).join(', ')}`);
      }
    } catch (e) {
      log('No se pudieron parchear nametags de', path.basename(gamePath), e.message);
      out = gamePath;
    }
    patchedByGame.set(gamePath, out);
    return out;
  };

  // Full-set: cada juego se parte en chunks de ~30s de gameplay. Renders de
  // juego completo (~15+ min por proceso) morían silenciosamente en este
  // servidor; chunks cortos acotan memoria/tiempo por proceso, y si uno cae
  // el retry solo repite ese tramo.
  const FULL_SET_CHUNK_FRAMES = 1800;

  // Expande items a unidades de render (full-set: N chunks por juego).
  const units = [];
  // Rótulos por chunk (full-set): el PRIMER chunk de cada juego lleva drawtext
  // "Juego N - Stage" los primeros ~6s, quemado en la fase normalize.
  const chapterByClipName = {};
  let gameNum = 0;
  for (const item of items) {
    // Frames custom (vienen del preview ajustado por el usuario) tienen
    // prioridad sobre la ventana calculada del stock.
    const hasCustomFrames =
      Number.isFinite(item.startFrame) && Number.isFinite(item.endFrame) && item.endFrame > item.startFrame;
    if (type === 'full-set') {
      gameNum += 1;
      const frames = fullGameFrames(item.gamePath);
      let stage = null;
      try { stage = getGameStocks(item.gamePath).stage; } catch (e) { /* sin stage */ }
      const chapterLabel = `Juego ${gameNum} - ${stage || 'Melee'}`;
      for (let f = frames.startFrame; f <= frames.endFrame; f += FULL_SET_CHUNK_FRAMES) {
        const clipName = `part-${String(units.length + 1).padStart(4, '0')}`;
        if (f === frames.startFrame) chapterByClipName[clipName] = chapterLabel;
        units.push({
          gamePath: item.gamePath,
          startFrame: f,
          endFrame: Math.min(f + FULL_SET_CHUNK_FRAMES - 1, frames.endFrame),
        });
      }
    } else {
      const frames = hasCustomFrames
        ? { startFrame: Math.round(item.startFrame), endFrame: Math.round(item.endFrame) }
        : stockFrames(item.gamePath, item.stockId, leadSeconds || 0);
      units.push({ gamePath: item.gamePath, ...frames, stockId: item.stockId });
    }
  }

  const total = units.length;
  const startedAt = Date.now();
  let keepParts = false;
  if (vertical) log('vertical=true: el reel sale en 1080x1920 con gameplay completo (sin crop) y fondo blurred.');

  try {
    const subClips = [];
    for (let i = 0; i < units.length; i++) {
      if (isCancelled(queue, job.id)) throw new CancelledError();

      const unit = units[i];
      const clipName = `part-${String(i + 1).padStart(4, '0')}`;
      const frames = { startFrame: unit.startFrame, endFrame: unit.endFrame };

      // Reanudar tras retry: si el part ya existe del intento anterior, se
      // reusa — pero solo si su duración real cuadra con los frames esperados.
      // (Un ffmpeg huérfano de un render matado puede dejar un part truncado.)
      const existing = path.join(tempDir, `${clipName}.mp4`);
      if (fs.existsSync(existing) && fs.statSync(existing).size > 0) {
        const expectedSec = (frames.endFrame - frames.startFrame + 1) / FPS;
        const actualSec = ffprobeDurationSec(existing);
        // slp-to-video recorta ~2s de padding al inicio; tolerancia de 6s.
        if (actualSec !== null && Math.abs(actualSec - expectedSec) <= 6) {
          log(`Render ${i + 1}/${total}: ${clipName} ya existe (reanudando)`);
          subClips.push(existing);
          continue;
        }
        log(`Render ${i + 1}/${total}: ${clipName} existe pero truncado (${actualSec}s vs ~${expectedSec}s) — re-renderizando`);
        fs.rmSync(existing, { force: true });
      }

      log(`Render ${i + 1}/${total}: ${path.basename(unit.gamePath)}${unit.stockId ? ` ${unit.stockId}` : ''}`);
      const file = await renderSubClip(renderPathFor(unit.gamePath), frames, clipName, tempDir, queue, job.id,
        type === 'full-set' ? FULL_SET_QUALITY : {});
      subClips.push(file);

      const elapsedSec = (Date.now() - startedAt) / 1000;
      const etaSec = Math.round((elapsedSec / (i + 1)) * (total - i - 1));
      updateProgress(queue, job.id, { phase: 'render', current: i + 1, total, etaSec });
    }

    updateProgress(queue, job.id, { phase: 'concat', current: total, total, etaSec: null });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `${slugify(name)}-${type}${vertical ? '-vertical' : ''}-${ts}.mp4`;
    const outputPath = path.join(COMPILATIONS_DIR, fileName);
    await concatClips(subClips, outputPath, queue, job.id, chapterByClipName);

    // Vertical (Shorts/Reels): pillarbox — el gameplay 4:3 entra ENTERO,
    // escalado a 1080 de ancho con bandas negras arriba/abajo (sin crop).
    if (vertical) {
      updateProgress(queue, job.id, { phase: 'vertical', current: total, total, etaSec: null });
      await padToVertical(outputPath, queue, job.id);
    }

    const sizeBytes = fs.statSync(outputPath).size;
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    const result = {
      outputPath,
      outputUrl: `/compilations/${fileName}`,
      fileName,
      sizeBytes,
      clipCount: subClips.length,
      elapsedSeconds,
    };

    await notifyCompleted(job, set, result).catch((e) => log('Telegram notify error:', e.message));
    return result;
  } catch (err) {
    // En error conservamos los parts ya renderizados: el retry del job los
    // reusa y reanuda donde quedó. En cancelación se limpia igual.
    if (!(err instanceof CancelledError || err.cancelled)) keepParts = true;
    throw err;
  } finally {
    if (!keepParts) cleanupTempDir(tempDir);
  }
}

// Registra el mensaje en telegram-clip-index.json (mismo formato que
// send-telegram.js, más metadatos del set) para que telegram-compile-bot.js
// pueda resolver voice-overs. `outputPath` es siempre el archivo original
// (full quality) aunque a Telegram se envíe una versión comprimida.
// NOTA: ya no fija botones por editMessageReplyMarkup — el mensaje sale con
// el teclado de aprobación (approvals.approvalKeyboard) desde el envío.
async function registerClipMessage(messageId, outputPath, caption, job, opts, isText) {
  let index = {};
  try {
    if (fs.existsSync(CLIP_INDEX_FILE)) index = JSON.parse(fs.readFileSync(CLIP_INDEX_FILE, 'utf-8'));
  } catch (e) {
    log('Índice de clips ilegible, se regenera:', e.message);
  }
  index[String(messageId)] = {
    chatId: String(opts.chatId),
    filePath: path.resolve(outputPath),
    fileName: path.basename(outputPath),
    caption: escapeHtml(caption),
    sentAt: new Date().toISOString(),
    type: 'set-export',
    setName: job.payload.name,
    exportType: job.payload.type,
    isText: !!isText,
  };
  fs.writeFileSync(CLIP_INDEX_FILE, JSON.stringify(index, null, 2));
}

// Crea el approval (metadata de YouTube generada) y envía el video con el
// teclado de aprobación: [✅ Subir] [✏️ Título] [📝 Descripción] [❌ Descartar].
// El bot (telegram-compile-bot.js) resuelve los callbacks appr_*.
async function notifyCompleted(job, set, result) {
  const opts = { token: TELEGRAM_TOKEN, chatId: TELEGRAM_CHAT };
  const sizeMB = (result.sizeBytes / 1024 / 1024).toFixed(1);
  const header = [
    `✅ Set "${job.payload.name}" (${job.payload.type})`,
    describeSet(set),
    `Clips: ${result.clipCount} | Duración render: ${formatDuration(result.elapsedSeconds)} | ${sizeMB} MB`,
  ].filter(Boolean).join('\n');

  const metadata = generateMetadata({
    set,
    type: job.payload.type,
    items: job.payload.items || [],
    name: job.payload.name,
  });
  const approval = approvals.createApproval({
    filePath: result.outputPath,
    setId: job.payload.setId || set?.id || null,
    setName: job.payload.name,
    type: job.payload.type,
    title: metadata.title,
    description: metadata.description,
    tags: metadata.tags,
    header,
    chatId: String(opts.chatId),
  });
  const caption = buildApprovalCaption(approval);
  const replyMarkup = approvals.approvalKeyboard(approval.id);

  const finalize = async (sent, isText) => {
    approvals.updateApproval(approval.id, { messageId: sent.message_id, isText: !!isText });
    await registerClipMessage(sent.message_id, result.outputPath, caption, job, opts, isText);
  };

  const isFullSet = job.payload.type === 'full-set';
  const tooBig = isFullSet && result.sizeBytes > MAX_TELEGRAM_FULL_SET_BYTES;
  if (!tooBig) {
    try {
      const sent = await sendVideoMessage(result.outputPath, caption, { ...opts, replyMarkup });
      await finalize(sent, false);
      return;
    } catch (e) {
      log('No se pudo enviar video por Telegram:', e.message);
      // 413 = supera el límite real de la Bot API (~50MB). Recomprimir y reintentar.
      if (/413|too large|entity/i.test(e.message)) {
        try {
          const small = compressForTelegram(result.outputPath);
          if (small) {
            try {
              const sent = await sendVideoMessage(small, `${caption}\n(comprimido para Telegram)`, { ...opts, replyMarkup });
              // Se indexa el ORIGINAL (full quality) como fuente de subida.
              await finalize(sent, false);
              return;
            } finally {
              fs.unlink(small, () => {});
            }
          }
        } catch (e2) {
          log('Compresión para Telegram falló:', e2.message);
        }
      }
      log('Enviando ruta del archivo en vez del video.');
    }
  }
  const textCaption = `${caption}\n📁 ${result.outputUrl}\n${result.outputPath}`;
  const sent = await sendTextMessage(textCaption, { ...opts, html: true, replyMarkup });
  await finalize(sent, true);
}

// Recomprime un video para que quepa en el límite de la Bot API de Telegram.
// Devuelve la ruta del archivo temporal o null si no se pudo.
function compressForTelegram(inputPath) {
  const targetBytes = 45 * 1024 * 1024;
  const probe = spawnSync('ffprobe', [
    '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputPath,
  ], { encoding: 'utf-8' });
  const durationSec = parseFloat((probe.stdout || '').trim());
  if (!durationSec || !isFinite(durationSec)) return null;

  const audioKbps = 96;
  const totalKbps = Math.floor((targetBytes * 8) / durationSec / 1000);
  const videoKbps = totalKbps - audioKbps;
  if (videoKbps < 200) return null; // ni recomprimiendo cabe con calidad mínima

  const outPath = inputPath.replace(/\.mp4$/, '') + '-telegram.mp4';
  const enc = spawnSync('ffmpeg', [
    '-y', '-i', inputPath,
    '-c:v', 'libx264', '-preset', 'fast', '-b:v', `${videoKbps}k`,
    '-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`,
    '-c:a', 'aac', '-b:a', `${audioKbps}k`,
    '-movflags', '+faststart', outPath,
  ], { encoding: 'utf-8' });
  if (enc.status !== 0 || !fs.existsSync(outPath)) return null;
  return outPath;
}

// Notificación al encolar (la usa el endpoint y/o el worker).
async function notifyQueued({ name, type, itemCount, estimatedMinutes }) {
  const label = type === 'full-set' ? 'juegos' : 'stocks';
  await sendTextMessage(
    `🎬 Set "${name}" encolado: ${itemCount} ${label}, estimado ~${estimatedMinutes} min`,
    { token: TELEGRAM_TOKEN, chatId: TELEGRAM_CHAT }
  );
}

async function notifyFailed(job, error) {
  await sendTextMessage(
    `❌ Set "${job.payload?.name || job.id}" falló: ${String(error).slice(0, 300)}`,
    { token: TELEGRAM_TOKEN, chatId: TELEGRAM_CHAT }
  );
}

module.exports = { runSetExportJob, notifyQueued, notifyFailed, CancelledError, COMPILATIONS_DIR };
