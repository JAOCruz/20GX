// mac-worker.js
// Worker remoto de render: corre en la Mac (M3) y clama jobs de la cola de
// jarvis vía HTTP. Renderiza local con Slippi Dolphin.app + ffmpeg (GPU Metal,
// mucho más rápido que el servidor) y sube el mp4 terminado de vuelta.
//
// Flujo por job:
//   1. POST /api/worker/claim → job pendiente (set-export | preview)
//   2. Descarga los .slp (y pista de música si aplica) a caches locales
//   3. Corre runSetExportJob / runPreviewJob con un "queue shim" que reporta
//      progreso a jarvis y detecta cancelaciones (poll de status cada 3s)
//   4. Sube el mp4 a /output y confirma con /complete (jarvis notifica Telegram)
//
// Env requeridas (en .env):
//   WORKER_TOKEN  — token compartido con el server
//   JARVIS_API    — ej. http://100.87.41.106:8081
//   WORKER_NAME   — opcional, default: hostname
//   SLIPPI_DOLPHIN_PATH / SSBM_ISO_PATH — opcionales (hay defaults de macOS)

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const API = (process.env.JARVIS_API || 'http://100.87.41.106:8081').replace(/\/+$/, '');
const TOKEN = process.env.WORKER_TOKEN || '';
const WORKER_NAME = process.env.WORKER_NAME || os.hostname();
const POLL_MS = Number(process.env.WORKER_POLL_MS || '5000');
const TYPES = ['set-export', 'preview'];

const SLP_CACHE = path.join(__dirname, 'slp-cache');
const MUSIC_DIR = path.join(__dirname, 'music');
for (const d of [SLP_CACHE, MUSIC_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function log(...args) {
  console.log(`[mac-worker] ${new Date().toISOString()}`, ...args);
}

if (!TOKEN) {
  log('FATAL: falta WORKER_TOKEN en .env');
  process.exit(1);
}

const AUTH_HEADERS = { 'x-worker-token': TOKEN };

async function apiPost(route, body) {
  const res = await fetch(`${API}${route}`, {
    method: 'POST',
    headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`${route} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---------- Descarga de archivos que el render necesita ----------

// Cache local de .slp: slp-cache/<hash8 de la ruta>/<basename>. El hash evita
// colisiones entre juegos con el mismo nombre en carpetas distintas.
async function ensureSlp(remotePath) {
  const dir = path.join(SLP_CACHE, crypto.createHash('sha1').update(remotePath).digest('hex').slice(0, 8));
  const local = path.join(dir, path.basename(remotePath));
  if (fs.existsSync(local) && fs.statSync(local).size > 0) return local;
  fs.mkdirSync(dir, { recursive: true });
  log('descargando', path.basename(remotePath));
  const res = await fetch(`${API}/api/worker/file?path=${encodeURIComponent(remotePath)}`, {
    headers: AUTH_HEADERS,
  });
  if (!res.ok) throw new Error(`No se pudo descargar ${remotePath}: HTTP ${res.status}`);
  const tmp = `${local}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, local);
  return local;
}

async function ensureMusic(fileName) {
  const local = path.join(MUSIC_DIR, path.basename(fileName));
  if (fs.existsSync(local) && fs.statSync(local).size > 0) return local;
  log('descargando música:', fileName);
  const res = await fetch(`${API}/api/worker/music/${encodeURIComponent(fileName)}`, {
    headers: AUTH_HEADERS,
  });
  if (!res.ok) throw new Error(`No se pudo descargar música ${fileName}: HTTP ${res.status}`);
  const tmp = `${local}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, local);
  return local;
}

// ---------- Upload del resultado ----------

async function uploadOutput(jobId, filePath) {
  const size = fs.statSync(filePath).size;
  log(`subiendo ${path.basename(filePath)} (${(size / 1048576).toFixed(1)} MB)`);
  const res = await fetch(`${API}/api/worker/jobs/${jobId}/output`, {
    method: 'POST',
    headers: {
      ...AUTH_HEADERS,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
      'x-filename': encodeURIComponent(path.basename(filePath)),
    },
    body: fs.createReadStream(filePath),
    duplex: 'half',
  });
  if (!res.ok) throw new Error(`Upload falló: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---------- Queue shim: la interfaz síncrona que set-export/preview esperan,
// respaldada por HTTP (status cacheado, progreso throttled) ----------

function makeRemoteQueue(jobId) {
  let status = 'running';
  const statusTimer = setInterval(async () => {
    try {
      const res = await fetch(`${API}/api/queue/jobs/${jobId}`);
      if (res.ok) status = (await res.json()).status;
    } catch { /* red caída: conservar último status */ }
  }, 3000);

  // Heartbeat mientras renderiza: sin esto, a los 90s el server cree que el
  // worker murió y el fallback local de jarvis agarraría jobs en paralelo.
  const heartbeatTimer = setInterval(() => {
    apiPost('/api/worker/claim', { name: WORKER_NAME, types: TYPES, heartbeat: true })
      .catch(() => {});
  }, 30_000);

  let lastProgressAt = 0;
  let pendingProgress = null;
  let progressTimer = null;
  const flushProgress = () => {
    if (!pendingProgress) return;
    const progress = pendingProgress;
    pendingProgress = null;
    apiPost(`/api/worker/jobs/${jobId}/progress`, { progress }).catch(() => {});
  };
  const shim = {
    get: (id) => ({ id, status }),
    updateProgress: (id, progress) => {
      pendingProgress = progress;
      const now = Date.now();
      if (now - lastProgressAt >= 2000) {
        lastProgressAt = now;
        flushProgress();
      } else if (!progressTimer) {
        progressTimer = setTimeout(() => {
          progressTimer = null;
          lastProgressAt = Date.now();
          flushProgress();
        }, 2000 - (now - lastProgressAt));
      }
    },
  };
  return {
    shim,
    stop: () => {
      clearInterval(statusTimer);
      clearInterval(heartbeatTimer);
      if (progressTimer) clearTimeout(progressTimer);
      flushProgress();
    },
  };
}

// ---------- Ejecución de jobs ----------

async function runJob(job, setData) {
  const { shim, stop } = makeRemoteQueue(job.id);
  try {
    if (job.type === 'preview') {
      const { runPreviewJob } = require('./preview-render');
      const payload = { ...job.payload };
      payload.gamePath = await ensureSlp(payload.gamePath);
      const result = await runPreviewJob({ ...job, payload }, shim);
      await uploadOutput(job.id, result.filePath);
      await apiPost(`/api/worker/jobs/${job.id}/complete`, {
        result: { ...result, filePath: undefined },
      });
      log(`preview ${payload.id} listo y entregado`);
    } else if (job.type === 'set-export') {
      const { runSetExportJob, CancelledError } = require('./set-export');
      const payload = { ...job.payload };
      // Descargar todos los juegos primero: fallar rápido si falta alguno.
      payload.items = [];
      for (const item of job.payload.items || []) {
        payload.items.push({ ...item, gamePath: await ensureSlp(item.gamePath) });
      }
      if (payload.music?.file) await ensureMusic(payload.music.file);
      try {
        const result = await runSetExportJob({ ...job, payload }, shim, {
          set: setData,
          skipNotify: true, // Telegram + approval lo hace jarvis al complete
        });
        await uploadOutput(job.id, result.outputPath);
        await apiPost(`/api/worker/jobs/${job.id}/complete`, {
          result: { ...result, outputPath: undefined, outputUrl: undefined },
        });
        log(`set-export ${job.id} listo y entregado (${result.fileName})`);
        // Limpiar el mp4 local: ya está en jarvis, la Mac no es storage.
        fs.rmSync(result.outputPath, { force: true });
      } catch (err) {
        if (err instanceof CancelledError || err.cancelled) {
          await apiPost(`/api/worker/jobs/${job.id}/fail`, { cancelled: true });
          log(`job ${job.id} cancelado`);
          return;
        }
        throw err;
      }
    } else {
      throw new Error(`Tipo no soportado por mac-worker: ${job.type}`);
    }
  } catch (err) {
    if (err.cancelled) {
      await apiPost(`/api/worker/jobs/${job.id}/fail`, { cancelled: true }).catch(() => {});
      return;
    }
    log(`job ${job.id} falló:`, err.message);
    await apiPost(`/api/worker/jobs/${job.id}/fail`, { error: err.message }).catch(() => {});
  } finally {
    stop();
  }
}

// ---------- Loop principal ----------

let busy = false;
let shouldStop = false;

async function tick() {
  if (busy || shouldStop) return;
  let data;
  try {
    data = await apiPost('/api/worker/claim', { name: WORKER_NAME, types: TYPES });
  } catch (err) {
    log('claim falló (reintenta en el próximo tick):', err.message);
    return;
  }
  if (!data.job) return;
  busy = true;
  log(`procesando ${data.job.id} (${data.job.type})${data.job.payload?.name ? `: ${data.job.payload.name}` : ''}`);
  try {
    await runJob(data.job, data.setData);
  } finally {
    busy = false;
  }
}

function start() {
  log(`Worker iniciado: ${WORKER_NAME} → ${API} (poll ${POLL_MS}ms)`);
  const timer = setInterval(() => {
    if (shouldStop) {
      if (!busy) {
        clearInterval(timer);
        process.exit(0);
      }
      return;
    }
    tick();
  }, POLL_MS);
  tick();
}

process.on('SIGTERM', () => { log('SIGTERM — termino el job actual y salgo'); shouldStop = true; });
process.on('SIGINT', () => { log('SIGINT — termino el job actual y salgo'); shouldStop = true; });

start();
