// dashboard-server.js
// Backend para el dashboard de Slippi: lista juegos, selección y procesamiento.

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, exec, spawnSync } = require('child_process');
const { SlippiGame, moves: slippiMoves } = require('@slippi/slippi-js');
const { scanReplays, loadCachedGames, saveCachedGames, scanReplay } = require('./scan-replays');
const { detectStocks } = require('./detect-stocks');
const setsStore = require('./sets-store');
const { detectSets } = require('./detect-sets');
const { getSetStocks, selectStocksForDuration, estimateStockClipSeconds, CACHE_FILE: STOCKS_CACHE_FILE } = require('./sets-stocks');
const { notifyQueued: notifySetQueued, notifyCompleted: notifySetCompleted, notifyFailed: notifySetFailed } = require('./set-export');
const previewRender = require('./preview-render');
const { loadApprovals } = require('./approvals');
const thumbnails = require('./thumbnails');
const { startRecording, stopRecording, getRecordings, isRecording, deleteRecording, OUTPUT_DIR } = require('./discord-recorder');
const { startAutoSession, stopAutoSession, getSession } = require('./auto-session');
const { cutClip, cutClipAsync } = require('./cut-clips');
const { mixDiscordAudioForClip } = require('./discord-audio-sync');
const {
  notifyRenderStarted,
  notifyRenderCompleted,
  notifyRenderFailed,
  notifySessionStarted,
  notifySessionStopped,
} = require('./pipeline-notifications');
const { JobQueue } = require('./queue');
const scheduler = require('./scheduler');
const ytChannel = require('./youtube-channel');
const { generateMetadata } = require('./youtube-metadata');
const comboRanking = require('./combo-ranking');
const autoShorts = require('./auto-shorts');

const jobQueue = new JobQueue();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.DASHBOARD_PORT || 8081;
const REPLAYS_DIR = process.env.REPLAYS_DIR || path.join(__dirname, 'replays');
const DASHBOARD_DIR = path.join(__dirname, 'dashboard-ui', 'dist');
const DASHBOARD_GAMES_DIR = path.join(__dirname, 'dashboard');
const CLIPS_AUTO_DIR = path.join(__dirname, 'clips-auto');
const PREVIEWS_DIR = path.join(__dirname, 'previews');
const COMPILATIONS_DIR = path.join(__dirname, 'compilations');

app.use('/recordings', express.static(OUTPUT_DIR));
const CONFIG_FILE = path.join(__dirname, 'dashboard-config.json');

const jobs = new Map();
const activeGames = new Set();
let jobCounter = 0;
let activePreview = null; // { child, startTime } para poder cancelarlo
let scanState = { running: false, startedAt: null, completedAt: null, count: 0, error: null };

// Cola simple de renders para no lanzar múltiples procesos de Dolphin/ffmpeg
// al mismo tiempo y llenar la RAM.
const renderQueue = [];
let renderInProgress = false;

function enqueueRender(job, runner) {
  job.status = 'queued';
  renderQueue.push({ job, runner });
  processRenderQueue();
}

async function processRenderQueue() {
  if (renderInProgress) return;
  const item = renderQueue.shift();
  if (!item) return;
  renderInProgress = true;
  const { job, runner } = item;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  try {
    await runner();
    job.status = job.errors.length > 0 && job.done === 0 ? 'failed' : 'completed';
  } catch (err) {
    job.status = 'failed';
    job.errors.push({ file: 'internal', error: err.message });
  } finally {
    job.completedAt = new Date().toISOString();
    renderInProgress = false;
    // Procesar el siguiente render en cola.
    setImmediate(processRenderQueue);
  }
}

function ensureDirs() {
  if (!fs.existsSync(DASHBOARD_DIR)) fs.mkdirSync(DASHBOARD_DIR, { recursive: true });
  if (!fs.existsSync(CLIPS_AUTO_DIR)) fs.mkdirSync(CLIPS_AUTO_DIR, { recursive: true });
  if (!fs.existsSync(PREVIEWS_DIR)) fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
}

function loadDashboardConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {
      discordGuildId: process.env.DISCORD_GUILD_ID || '',
      discordChannelId: process.env.DISCORD_CHANNEL_ID || '',
      history: [],
    };
  }
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return {
      discordGuildId: saved.discordGuildId || process.env.DISCORD_GUILD_ID || '',
      discordChannelId: saved.discordChannelId || process.env.DISCORD_CHANNEL_ID || '',
      history: Array.isArray(saved.history) ? saved.history : [],
    };
  } catch (e) {
    return {
      discordGuildId: process.env.DISCORD_GUILD_ID || '',
      discordChannelId: process.env.DISCORD_CHANNEL_ID || '',
      history: [],
    };
  }
}

function saveDashboardConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function addDiscordHistory(config, guildId, channelId) {
  if (!guildId || !channelId) return config;
  const entry = { guildId, channelId, usedAt: new Date().toISOString() };
  // Evitar duplicados; mantener los últimos 10.
  const filtered = config.history.filter((h) => !(h.guildId === guildId && h.channelId === channelId));
  filtered.unshift(entry);
  config.history = filtered.slice(0, 10);
  return config;
}

function loadProcessedGames() {
  const targetDir = fs.existsSync(DASHBOARD_GAMES_DIR) ? DASHBOARD_GAMES_DIR : DASHBOARD_DIR;
  const files = fs.readdirSync(targetDir).filter((f) => f.endsWith('-games.json'));
  const all = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(targetDir, file), 'utf-8'));
      if (Array.isArray(data.games)) all.push(...data.games);
    } catch (e) {
      // ignore
    }
  }
  return all.sort((a, b) => {
    const da = a.fileName || '';
    const db = b.fileName || '';
    return db.localeCompare(da);
  });
}

// Mata procesos huérfanos de Dolphin/Xvfb/ffmpeg/slp-to-video que tengan más
// de ORPHAN_MAX_MINUTES minutos. Se ejecuta al iniciar y periódicamente.
const ORPHAN_MAX_MINUTES = Number(process.env.ORPHAN_MAX_MINUTES || 10);
const ORPHAN_PATTERNS = [
  /Slippi_Playback/,
  /Dolphin/,
  /Xvfb/,
  /ffmpeg/,
  /slp-to-video/,
];

function cleanupOrphanedProcesses() {
  exec("ps -eo pid,etime,cmd", (err, stdout) => {
    if (err) return;
    const lines = stdout.split('\n').slice(1);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) continue;
      const pid = parts[0];
      const etime = parts[1];
      const cmd = parts.slice(2).join(' ');
      const matches = ORPHAN_PATTERNS.some((p) => p.test(cmd));
      if (!matches) continue;
      // etime formato: [[DD-]hh:]mm:ss
      const timeMatch = etime.match(/(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)/);
      if (!timeMatch) continue;
      const days = parseInt(timeMatch[1] || '0', 10);
      const hours = parseInt(timeMatch[2] || '0', 10);
      const minutes = parseInt(timeMatch[3] || '0', 10);
      const totalMinutes = days * 24 * 60 + hours * 60 + minutes;
      if (totalMinutes >= ORPHAN_MAX_MINUTES) {
        try {
          process.kill(Number(pid), 'SIGKILL');
          console.log(`[cleanup] Matado proceso huérfano PID ${pid} (${cmd.slice(0, 80)})`);
        } catch (e) {
          // ignore
        }
      }
    }
  });
}

setInterval(cleanupOrphanedProcesses, 5 * 60 * 1000);
cleanupOrphanedProcesses();

// GET /api/status — health check
app.get('/api/status', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), replaysDir: REPLAYS_DIR });
});

// GET /api/system — recursos del servidor
app.get('/api/system', (req, res) => {
  exec("ps -eo pid,etime,cmd | grep -E 'Slippi_Playback|Dolphin|Xvfb|ffmpeg|slp-to-video' | grep -v grep", (err, stdout) => {
    const procs = stdout
      ? stdout.split('\n').filter((l) => l.trim()).map((l) => {
          const parts = l.trim().split(/\s+/);
          return { pid: parts[0], etime: parts[1], cmd: parts.slice(2).join(' ').slice(0, 120) };
        })
      : [];
    exec("df -h / | tail -1", (dfErr, dfOut) => {
      const dfLine = dfOut ? dfOut.trim().split(/\s+/) : [];
      res.json({
        memory: {
          total: os.totalmem(),
          free: os.freemem(),
          used: os.totalmem() - os.freemem(),
        },
        uptimeSeconds: os.uptime(),
        disk: {
          filesystem: dfLine[0] || null,
          size: dfLine[1] || null,
          used: dfLine[2] || null,
          available: dfLine[3] || null,
          usePercent: dfLine[4] || null,
        },
        processes: procs,
        scanState,
        activePreview: activePreview ? { startTime: activePreview.startTime } : null,
        jobs: {
          pending: jobQueue.countPending(),
          running: jobQueue.countRunning(),
        },
      });
    });
  });
});

// GET /api/games — devuelve juegos cacheados (o vacío si aún no se ha escaneado)
app.get('/api/games', (req, res) => {
  const cache = loadCachedGames();
  if (!cache) return res.json({ cached: false, count: 0, games: [] });
  const recordings = getRecordings();
  const games = cache.games.map((g) => ({
    ...g,
    hasRecording: recordings.some((rec) => gameOverlapsRecording(g, rec)),
  }));
  res.json({ cached: true, ...cache, count: games.length, games });
});

// POST /api/refresh — escanea rápido sin duración por defecto
app.post('/api/refresh', async (req, res) => {
  const includeDuration = req.query.duration === '1';
  const days = Number(req.query.days || 0) || 0;
  if (scanState.running) {
    return res.status(409).json({ message: 'Scan already running', scanState });
  }

  scanState = { running: true, startedAt: new Date().toISOString(), completedAt: null, count: 0, error: null };
  res.json({ message: 'Scan started', includeDuration, days });

  const args = [];
  if (includeDuration) args.push('--duration');
  if (days > 0) args.push(`--max-age-days=${days}`);

  const child = spawn('node', [path.join(__dirname, 'scan-worker.js'), ...args], {
    cwd: __dirname,
    env: { ...process.env, REPLAYS_DIR },
  });

  child.stdout.on('data', (d) => {
    const text = d.toString();
    // Parsear progreso: "[scan-worker] 25/654"
    const m = text.match(/\[scan-worker\]\s*(\d+)\/(\d+)/);
    if (m) {
      scanState.count = parseInt(m[1], 10);
    }
  });

  child.on('close', (code) => {
    if (code === 0) {
      const cache = loadCachedGames();
      scanState = {
        running: false,
        startedAt: scanState.startedAt,
        completedAt: new Date().toISOString(),
        count: cache?.count || 0,
        error: null,
      };
      console.log(`[scan] Cache guardado: ${cache?.count || 0} juegos`);
    } else {
      scanState = {
        running: false,
        startedAt: scanState.startedAt,
        completedAt: new Date().toISOString(),
        count: 0,
        error: `scan-worker salió con código ${code}`,
      };
      console.error('[scan] Error: scan-worker salió con código', code);
    }
  });

  child.on('error', (err) => {
    scanState = {
      running: false,
      startedAt: scanState.startedAt,
      completedAt: new Date().toISOString(),
      count: 0,
      error: err.message,
    };
    console.error('[scan] Error lanzando worker:', err);
  });
});

// GET /api/scan-status — estado del scan en curso
app.get('/api/scan-status', (req, res) => {
  res.json(scanState);
});

// POST /api/process — procesa los juegos seleccionados
app.post('/api/process', (req, res) => {
  const { games, options = {} } = req.body;
  if (!Array.isArray(games) || games.length === 0) {
    return res.status(400).json({ error: 'Debes seleccionar al menos un juego' });
  }

  const filePaths = games.map((g) => g.filePath).filter(Boolean);
  const alreadyRunning = filePaths.find((p) => activeGames.has(p));
  if (alreadyRunning) {
    return res.status(409).json({ error: `Ya hay un render en curso para ${path.basename(alreadyRunning)}. Espera a que termine.` });
  }

  const jobId = `job-${++jobCounter}`;
  const job = {
    id: jobId,
    status: 'queued',
    startedAt: new Date().toISOString(),
    completedAt: null,
    total: games.length,
    done: 0,
    errors: [],
    outputs: [],
  };
  jobs.set(jobId, job);
  filePaths.forEach((p) => activeGames.add(p));

  enqueueRender(job, async () => {
    try {
      for (let i = 0; i < games.length; i++) {
        const game = games[i];
        try {
          const output = await processGame(game, options);
          job.outputs.push(output);
        } catch (err) {
          job.errors.push({ file: game.filePath, error: err.message });
        }
        job.done = i + 1;
      }
    } finally {
      filePaths.forEach((p) => activeGames.delete(p));
    }
  });

  res.json({ jobId, message: `Procesando ${games.length} juego(s)`, status: 'queued' });
});

// GET /api/jobs/:id — estado de un job (legacy, in-process)
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

// Queue endpoints (production worker architecture)
app.post('/api/queue/render', (req, res) => {
  const { games, options = {} } = req.body;
  if (!Array.isArray(games) || games.length === 0) {
    return res.status(400).json({ error: 'Debes enviar al menos un juego' });
  }
  const totalStocks = games.reduce((sum, g) => sum + (g.selectedStocks?.length || 0), 0);
  if (totalStocks === 0) {
    return res.status(400).json({ error: 'No hay stocks seleccionados' });
  }

  const ids = [];
  for (const game of games) {
    if (!game.selectedStocks || game.selectedStocks.length === 0) continue;
    const id = jobQueue.add('render-stock', {
      filePath: game.filePath,
      mainPlayer: game.mainPlayer,
      opponent: game.opponent,
      selectedStocks: game.selectedStocks,
      options,
    });
    ids.push(id);
  }

  res.json({ ok: true, jobIds: ids, message: `${ids.length} job(s) encolados` });
});

app.get('/api/queue/jobs', (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const status = req.query.status || undefined;
  res.json({ jobs: jobQueue.list({ status, limit }) });
});

app.get('/api/queue/jobs/:id', (req, res) => {
  const job = jobQueue.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

app.post('/api/queue/jobs/:id/cancel', (req, res) => {
  const ok = jobQueue.cancel(req.params.id);
  res.json({ ok, message: ok ? 'Job cancelado' : 'No se pudo cancelar (solo pendientes o en ejecución)' });
});

// ---------- Sets (series de juegos entre dos jugadores) ----------

// Parsea los juegos y deriva players/wins/format/date del set.
// winnerOverrides: { [gamePath]: playerIndex } — corrección manual del ganador.
function deriveSetData(gamePaths, winnerOverrides) {
  const parsed = [];
  for (const p of gamePaths) {
    const g = scanReplay(p);
    if (!g) throw new Error(`No se pudo parsear ${path.basename(p)}`);
    parsed.push(g);
  }

  // Identidad: connectCode si existe; si no (replays offline), el puerto.
  // El nombre visible es el connectCode, o el nametag, o "P1"/"P2".
  const keyOf = (pl) =>
    pl.connectCode && pl.connectCode !== '—' ? pl.connectCode : `port:${pl.playerIndex}`;
  const nameOf = (pl) =>
    pl.connectCode && pl.connectCode !== '—' ? pl.connectCode : pl.nametag || `P${pl.playerIndex + 1}`;

  const charByKey = {};
  const nameByKey = {};
  const keyByGamePlayer = [];
  for (const g of parsed) {
    const map = {};
    for (const pl of g.players || []) {
      const key = keyOf(pl);
      map[pl.playerIndex] = key;
      if (charByKey[key] === undefined) {
        charByKey[key] = pl.characterId;
        nameByKey[key] = nameOf(pl);
      } else if (pl.nametag && (!pl.connectCode || pl.connectCode === '—')) {
        nameByKey[key] = pl.nametag;
      }
    }
    keyByGamePlayer.push(map);
  }
  const codes = Object.keys(charByKey).slice(0, 2);
  const winsByCode = { [codes[0]]: 0, [codes[1]]: 0 };
  for (let gi = 0; gi < parsed.length; gi++) {
    const g = parsed[gi];
    // Override manual del ganador (corregido desde el dashboard).
    const ov = winnerOverrides ? winnerOverrides[g.filePath] : null;
    const winner = ov != null ? ov : g.winnerPlayerIndex;
    if (winner == null) continue;
    const key = keyByGamePlayer[gi][winner];
    if (key && winsByCode[key] !== undefined) winsByCode[key]++;
  }

  const wins = [winsByCode[codes[0]] || 0, winsByCode[codes[1]] || 0];
  const maxWins = Math.max(...wins);
  const dates = parsed.map((g) => g.startAt).filter(Boolean).sort();
  return {
    players: codes.map((key) => ({ connectCode: nameByKey[key] || key, characterId: charByKey[key] ?? null })),
    wins,
    format: maxWins >= 3 ? `FT${maxWins}` : null,
    date: dates[0] || null,
  };
}

function validateGamePaths(gamePaths) {
  if (!Array.isArray(gamePaths) || gamePaths.length === 0) {
    return 'Debes enviar gamePaths con al menos un juego';
  }
  for (const p of gamePaths) {
    if (typeof p !== 'string' || !p.endsWith('.slp')) return `Ruta inválida (debe ser .slp): ${p}`;
    if (!fs.existsSync(p)) return `No existe el archivo: ${p}`;
  }
  return null;
}

// Guarda un buffer en destDir con nombre único (agrega -2, -3... si ya existe).
function saveUniqueFile(destDir, filename, buffer) {
  const safe = path.basename(filename).replace(/[^\w.\- ()#]+/g, '_') || 'replay.slp';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(destDir, safe);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(destDir, `${stem}-${n}${ext}`);
    n++;
  }
  fs.writeFileSync(candidate, buffer);
  return candidate;
}

// ---------- Música para exports ----------

const MUSIC_DIR = path.join(__dirname, 'music');
if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });
const MUSIC_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.aac', '.flac']);

function musicDurationSec(filePath) {
  const out = spawnSync('ffprobe', [
    '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath,
  ], { encoding: 'utf-8' });
  const d = parseFloat((out.stdout || '').trim());
  return Number.isFinite(d) ? Math.round(d) : null;
}

// GET /api/music — lista de pistas subidas
app.get('/api/music', (req, res) => {
  try {
    const tracks = fs.readdirSync(MUSIC_DIR)
      .filter((f) => MUSIC_EXTS.has(path.extname(f).toLowerCase()))
      .map((f) => {
        const p = path.join(MUSIC_DIR, f);
        return { name: f, sizeBytes: fs.statSync(p).size, durationSec: musicDurationSec(p) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ tracks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/music — sube una pista (binario crudo, header x-filename).
app.post('/api/music', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '200mb' }), (req, res) => {
  try {
    let filename = '';
    try {
      filename = path.basename(decodeURIComponent(String(req.headers['x-filename'] || '')));
    } catch {
      filename = path.basename(String(req.headers['x-filename'] || ''));
    }
    if (!filename) return res.status(400).json({ error: 'Falta header x-filename' });
    if (!MUSIC_EXTS.has(path.extname(filename).toLowerCase())) {
      return res.status(400).json({ error: `Extensión no soportada (usa ${[...MUSIC_EXTS].join(', ')})` });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Body vacío (se esperaba application/octet-stream)' });
    }
    const dest = path.join(MUSIC_DIR, filename);
    fs.writeFileSync(dest, req.body);
    console.log(`[music] subida: ${filename} (${(req.body.length / 1024 / 1024).toFixed(1)} MB)`);
    res.json({ ok: true, track: { name: filename, sizeBytes: req.body.length, durationSec: musicDurationSec(dest) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/music/:name — borra una pista
app.delete('/api/music/:name', (req, res) => {
  try {
    const p = path.join(MUSIC_DIR, path.basename(req.params.name));
    if (!p.startsWith(MUSIC_DIR) || !fs.existsSync(p)) {
      return res.status(404).json({ error: 'Pista no encontrada' });
    }
    fs.rmSync(p, { force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Valida el payload music del export/schedule: { file, gameVolume? 0-1 }.
// Devuelve el objeto limpio, null (sin música) o lanza 400 vía res.
function parseMusicParam(raw) {
  if (raw == null) return null;
  const file = path.basename(String(raw.file || ''));
  if (!file || !fs.existsSync(path.join(MUSIC_DIR, file))) {
    throw new Error(`Pista de música no encontrada: ${raw.file}`);
  }
  const gv = raw.gameVolume == null ? 0.2 : Number(raw.gameVolume);
  return { file, gameVolume: Math.max(0, Math.min(1, Number.isFinite(gv) ? gv : 0.2)) };
}

// ---------- Worker remoto (Mac como render worker) ----------
// La Mac clama jobs por HTTP, renderiza local con su Dolphin + GPU (Metal) y
// sube el mp4 terminado. Jarvis queda de fallback: su worker local cede los
// tipos remotos mientras haya un worker remoto vivo (heartbeat = cada claim).

const WORKER_TOKEN = process.env.WORKER_TOKEN || null;
const REMOTE_WORKER_TYPES = ['set-export', 'preview'];
const remoteWorkers = new Map(); // name -> { lastSeen, types }

function isRemoteWorkerActive() {
  const now = Date.now();
  for (const w of remoteWorkers.values()) {
    if (now - w.lastSeen < 90 * 1000) return true;
  }
  return false;
}

function checkWorkerToken(req, res) {
  if (!WORKER_TOKEN) {
    res.status(503).json({ error: 'WORKER_TOKEN no configurado en el server' });
    return false;
  }
  if (req.headers['x-worker-token'] !== WORKER_TOKEN) {
    res.status(401).json({ error: 'Token de worker inválido' });
    return false;
  }
  return true;
}

// GET /api/worker/status — lo consulta el worker local para ceder el paso.
app.get('/api/worker/status', (req, res) => {
  res.json({
    remoteActive: isRemoteWorkerActive(),
    workers: [...remoteWorkers.entries()].map(([name, w]) => ({
      name,
      lastSeen: new Date(w.lastSeen).toISOString(),
      types: w.types,
    })),
  });
});

// POST /api/worker/claim {name, types} — heartbeat + claim atómico del job
// pendiente más viejo de los tipos pedidos. Devuelve {job, setData} (setData:
// el worker remoto no tiene sets.json).
app.post('/api/worker/claim', (req, res) => {
  if (!checkWorkerToken(req, res)) return;
  const name = String(req.body?.name || 'remote').slice(0, 40);
  const types = Array.isArray(req.body?.types) && req.body.types.length > 0
    ? req.body.types.filter((t) => REMOTE_WORKER_TYPES.includes(t))
    : REMOTE_WORKER_TYPES;
  remoteWorkers.set(name, { lastSeen: Date.now(), types });
  // heartbeat puro: el worker está ocupado renderizando pero sigue vivo —
  // actualiza lastSeen SIN clamar otro job.
  if (req.body?.heartbeat) return res.json({ job: null });
  const job = jobQueue.claimNextTypes(types);
  if (!job) return res.json({ job: null });
  const setData = job.payload?.setId ? setsStore.getSet(job.payload.setId) : null;
  console.log(`[worker-api] ${name} clamó ${job.id} (${job.type})`);
  res.json({ job, setData });
});

// POST /api/worker/jobs/:id/progress {progress}
app.post('/api/worker/jobs/:id/progress', (req, res) => {
  if (!checkWorkerToken(req, res)) return;
  const progress = { ...(req.body?.progress || {}), _remoteAt: Date.now() };
  try { jobQueue.updateProgress(req.params.id, progress); } catch { /* job borrado */ }
  res.json({ ok: true });
});

// POST /api/worker/jobs/:id/output — sube el mp4 final (streaming crudo).
// Header: x-filename (encodeURIComponent). Se escribe a .part y se renombra.
app.post('/api/worker/jobs/:id/output', (req, res) => {
  if (!checkWorkerToken(req, res)) return;
  const job = jobQueue.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  let fileName;
  try { fileName = path.basename(decodeURIComponent(String(req.headers['x-filename'] || ''))); }
  catch { fileName = path.basename(String(req.headers['x-filename'] || '')); }
  if (!fileName || !fileName.endsWith('.mp4')) {
    return res.status(400).json({ error: 'x-filename debe terminar en .mp4' });
  }
  const dir = job.type === 'preview' ? previewRender.PREVIEWS_DIR : COMPILATIONS_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, fileName);
  const tmp = `${dest}.part-${Date.now()}`;
  const ws = fs.createWriteStream(tmp);
  req.pipe(ws);
  ws.on('error', (err) => {
    fs.rmSync(tmp, { force: true });
    res.status(500).json({ error: err.message });
  });
  ws.on('finish', () => {
    const size = fs.statSync(tmp).size;
    if (size === 0) {
      fs.rmSync(tmp, { force: true });
      return res.status(400).json({ error: 'Archivo vacío' });
    }
    fs.renameSync(tmp, dest);
    console.log(`[worker-api] output recibido: ${fileName} (${(size / 1048576).toFixed(1)} MB)`);
    res.json({ ok: true, path: dest, sizeBytes: size });
  });
});

// POST /api/worker/jobs/:id/complete {result} — valida que el output ya se
// subió, reescribe paths al filesystem de jarvis y dispara la notificación
// Telegram/approval (el worker remoto corre con skipNotify).
app.post('/api/worker/jobs/:id/complete', (req, res) => {
  if (!checkWorkerToken(req, res)) return;
  const job = jobQueue.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  if (job.status === 'cancelled') return res.json({ ok: true, ignored: 'cancelled' });
  const result = req.body?.result || {};
  try {
    if (job.type === 'set-export') {
      const fileName = path.basename(result.fileName || '');
      const dest = fileName ? path.join(COMPILATIONS_DIR, fileName) : null;
      if (!dest || !fs.existsSync(dest)) {
        return res.status(400).json({ error: 'Falta el output (subilo a /output primero)' });
      }
      const finalResult = {
        ...result,
        outputPath: dest,
        outputUrl: `/compilations/${fileName}`,
        sizeBytes: fs.statSync(dest).size,
      };
      jobQueue.complete(job.id, { progress: { phase: 'done', ...finalResult } });
      const set = job.payload.setId ? setsStore.getSet(job.payload.setId) : null;
      notifySetCompleted(job, set, finalResult)
        .catch((e) => console.warn('[worker-api] notify completed error:', e.message));
    } else if (job.type === 'preview') {
      const pvId = job.payload.id;
      const dest = previewRender.previewFilePath(pvId);
      if (!fs.existsSync(dest)) {
        return res.status(400).json({ error: 'Falta el output (subilo a /output primero)' });
      }
      previewRender.registerPreview({
        id: pvId,
        gamePath: job.payload.gamePath,
        startFrame: job.payload.startFrame,
        endFrame: job.payload.endFrame,
        fileName: path.basename(dest),
        status: 'done',
        createdAt: new Date().toISOString(),
      });
      jobQueue.complete(job.id, {
        progress: { phase: 'done', ...result, outputPath: dest, filePath: dest },
      });
    } else {
      return res.status(400).json({ error: `Tipo ${job.type} no completable por worker remoto` });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/worker/jobs/:id/fail {error, cancelled}
app.post('/api/worker/jobs/:id/fail', (req, res) => {
  if (!checkWorkerToken(req, res)) return;
  const job = jobQueue.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  if (req.body?.cancelled) return res.json({ ok: true, ignored: 'cancelled' });
  const error = String(req.body?.error || 'error desconocido').slice(0, 500);
  jobQueue.fail(job.id, error);
  if (job.type === 'set-export') notifySetFailed(job, error).catch(() => {});
  res.json({ ok: true });
});

// GET /api/worker/file?path=/abs/juego.slp — descarga de replays para el
// render remoto. Solo .slp absolutos que existan.
app.get('/api/worker/file', (req, res) => {
  if (!checkWorkerToken(req, res)) return;
  const p = String(req.query.path || '');
  if (!p.endsWith('.slp') || !path.isAbsolute(p)) {
    return res.status(400).json({ error: 'Solo archivos .slp absolutos' });
  }
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'No existe' });
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});

// GET /api/worker/music/:name — descarga de pistas para mezclar en remoto.
app.get('/api/worker/music/:name', (req, res) => {
  if (!checkWorkerToken(req, res)) return;
  const p = path.join(MUSIC_DIR, path.basename(req.params.name));
  if (!p.startsWith(MUSIC_DIR) || !fs.existsSync(p)) {
    return res.status(404).json({ error: 'No existe' });
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});

// Reaper: un job clamó un worker remoto y la máquina murió/desconectó →
// vuelve a pending (queue.fail re-encola mientras queden retries) para que lo
// tome el fallback local o el propio worker al volver. Corre cada 5 min.
setInterval(() => {
  try {
    if (isRemoteWorkerActive()) return;
    const running = jobQueue.list({ status: 'running', limit: 100 });
    const now = Date.now();
    for (const job of running) {
      if (!REMOTE_WORKER_TYPES.includes(job.type)) continue;
      const remoteAt = job.progress?._remoteAt;
      if (!remoteAt) continue; // job local, no tocar
      if (now - remoteAt > 10 * 60 * 1000) {
        console.warn(`[worker-api] reaper: ${job.id} (${job.type}) sin worker remoto vivo → reintento`);
        jobQueue.fail(job.id, 'worker remoto desconectado');
      }
    }
  } catch (e) {
    console.warn('[worker-api] reaper error:', e.message);
  }
}, 5 * 60 * 1000);

// POST /api/import — sube .slp o .zip (binario crudo) para importar replays.
// Solo guarda archivos y devuelve paths; la creación/actualización del set la
// hace el frontend llamando a POST /api/sets o PUT /api/sets/:id al terminar.
// Query: target=set&name=... | target=add-to-set&setId=... | target=games
app.post('/api/import', express.raw({ type: 'application/octet-stream', limit: '3gb' }), async (req, res) => {
  try {
    const target = String(req.query.target || 'games');
    let filename = '';
    try {
      filename = path.basename(decodeURIComponent(String(req.headers['x-filename'] || '')));
    } catch {
      filename = path.basename(String(req.headers['x-filename'] || ''));
    }
    if (!filename) return res.status(400).json({ error: 'Falta header x-filename' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Body vacío (se esperaba application/octet-stream)' });
    }

    let destDir;
    if (target === 'set') {
      const name = String(req.query.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Falta query param name para target=set' });
      destDir = path.join(REPLAYS_DIR, 'sets-import', setsStore.slugify(name));
    } else if (target === 'add-to-set') {
      const setId = String(req.query.setId || '');
      const set = setsStore.getSet(setId);
      if (!set) return res.status(404).json({ error: 'Set no encontrado' });
      const first = (set.gamePaths || [])[0];
      destDir = first
        ? path.dirname(first)
        : path.join(REPLAYS_DIR, 'sets-import', setsStore.slugify(set.name));
    } else if (target === 'games') {
      destDir = path.join(REPLAYS_DIR, 'imported');
    } else {
      return res.status(400).json({ error: `target inválido: ${target}` });
    }
    fs.mkdirSync(destDir, { recursive: true });

    const savedPaths = [];
    const lower = filename.toLowerCase();
    if (lower.endsWith('.slp')) {
      savedPaths.push(saveUniqueFile(destDir, filename, req.body));
    } else if (lower.endsWith('.zip')) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slp-import-'));
      try {
        const zipPath = path.join(tmpDir, 'upload.zip');
        fs.writeFileSync(zipPath, req.body);
        await new Promise((resolve, reject) => {
          const child = spawn('unzip', ['-o', zipPath, '-d', path.join(tmpDir, 'x')]);
          let errOut = '';
          child.stderr.on('data', (d) => (errOut += d.toString()));
          child.on('error', reject);
          child.on('close', (code) =>
            code === 0
              ? resolve()
              : reject(new Error(`unzip salió con código ${code}: ${errOut.slice(0, 300)}`))
          );
        });
        const slpFiles = [];
        (function walk(dir) {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.toLowerCase().endsWith('.slp')) slpFiles.push(full);
          }
        })(path.join(tmpDir, 'x'));
        for (const f of slpFiles.sort()) {
          savedPaths.push(saveUniqueFile(destDir, path.basename(f), fs.readFileSync(f)));
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } else {
      return res.status(400).json({ error: 'Solo se aceptan archivos .slp o .zip' });
    }

    console.log(`[import] target=${target} archivo=${filename} → ${savedPaths.length} .slp en ${destDir}`);
    res.json({ ok: true, saved: savedPaths.length, paths: savedPaths });
  } catch (err) {
    console.error('[import] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sets — lista de sets con gameCount y durationSec calculados
app.get('/api/sets', (req, res) => {
  const cache = loadCachedGames() || { games: [] };
  const durationByPath = new Map(cache.games.map((g) => [g.filePath, g.duration || 0]));
  const sets = setsStore.listSets().map((s) => ({
    ...s,
    gameCount: (s.gamePaths || []).length,
    durationSec: (s.gamePaths || []).reduce((sum, p) => sum + (durationByPath.get(p) || 0), 0),
  }));
  res.json({ sets });
});

// POST /api/sets — crea un set manual
app.post('/api/sets', (req, res) => {
  const { name, gamePaths } = req.body || {};
  const invalid = validateGamePaths(gamePaths);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const derived = deriveSetData(gamePaths);
    const set = setsStore.createSet({
      name: name || setsStore.autoName(derived.players, derived.date),
      source: 'manual',
      ...derived,
      gamePaths,
    });
    res.json({ ok: true, set });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sets/:id — renombrar y/o reordenar juegos
app.put('/api/sets/:id', (req, res) => {
  const existing = setsStore.getSet(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Set no encontrado' });

  const { name, gamePaths, storyNotes, playerNames, winnerOverrides } = req.body || {};
  const patch = {};
  if (name !== undefined) patch.name = String(name);
  if (storyNotes !== undefined) patch.storyNotes = storyNotes == null ? null : String(storyNotes);
  // Nombres de display por jugador (para parchear nametags vacíos al renderizar).
  if (playerNames !== undefined) {
    if (!Array.isArray(playerNames) || playerNames.some((n) => typeof n !== 'string')) {
      return res.status(400).json({ error: 'playerNames debe ser un array de strings' });
    }
    patch.playerNames = playerNames.map((n) => n.trim().slice(0, 16));
  }
  // Overrides manuales de ganador: { [gamePath]: playerIndex | null }.
  // null elimina el override. Solo paths que ya están en el set.
  if (winnerOverrides !== undefined) {
    if (typeof winnerOverrides !== 'object' || winnerOverrides === null || Array.isArray(winnerOverrides)) {
      return res.status(400).json({ error: 'winnerOverrides debe ser un objeto { gamePath: playerIndex }' });
    }
    const merged = { ...(existing.winnerOverrides || {}) };
    const validPaths = new Set(gamePaths ?? existing.gamePaths ?? []);
    for (const [p, idx] of Object.entries(winnerOverrides)) {
      if (!validPaths.has(p)) {
        return res.status(400).json({ error: `Override para juego que no está en el set: ${path.basename(p)}` });
      }
      if (idx === null) delete merged[p];
      else if (typeof idx === 'number' && Number.isInteger(idx)) merged[p] = idx;
      else return res.status(400).json({ error: `playerIndex inválido para ${path.basename(p)}` });
    }
    patch.winnerOverrides = merged;
  }
  if (gamePaths !== undefined || winnerOverrides !== undefined) {
    const paths = gamePaths ?? existing.gamePaths;
    const invalid = validateGamePaths(paths);
    if (invalid) return res.status(400).json({ error: invalid });
    try {
      Object.assign(
        patch,
        deriveSetData(paths, patch.winnerOverrides ?? existing.winnerOverrides),
        { gamePaths: paths }
      );
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  const set = setsStore.updateSet(req.params.id, patch);
  res.json({ ok: true, set });
});

// DELETE /api/sets/:id
app.delete('/api/sets/:id', (req, res) => {
  const ok = setsStore.deleteSet(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Set no encontrado' });
  res.json({ ok: true });
});

// POST /api/sets/detect — auto-detecta sets sobre todos los juegos conocidos
app.post('/api/sets/detect', (req, res) => {
  const cache = loadCachedGames();
  if (!cache) return res.status(409).json({ error: 'No hay juegos cacheados; corre un scan primero' });
  try {
    const result = detectSets(cache.games, setsStore.loadSets());
    res.json({ added: result.added, sets: result.sets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sets/:id/stocks — stocks por juego con scoring (cacheado en disco)
app.get('/api/sets/:id/stocks', (req, res) => {
  const set = setsStore.getSet(req.params.id);
  if (!set) return res.status(404).json({ error: 'Set no encontrado' });
  try {
    const { games, errors } = getSetStocks(set);
    res.json({ games, ...(errors.length ? { errors } : {}) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Top Combos ----------

const SLIPPI_FIRST_FRAME = -123; // frame mínimo de un replay (cuenta regresiva)

// Fecha del juego desde el nombre de archivo (Game_YYYYMMDDTHHMMSS).
function gameDateFromName(p) {
  const m = path.basename(p).match(/Game_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

// Aplana stocks con comboLength >= minHits y los ordena para el ranking:
// comboLength desc, luego score desc.
function topComboItems(gamesStocks, minHits) {
  const items = [];
  for (const g of gamesStocks) {
    for (const s of g.stocks || []) {
      if ((s.comboLength || 0) < minHits) continue;
      const killer = (g.players || []).find((p) => p.playerIndex === s.killerIndex);
      const victim = (g.players || []).find((p) => p.playerIndex === s.victimIndex);
      // Contexto: desde el inicio del combo -4s de neutral; si no hay
      // comboStartFrame, 8s antes del kill. Clamp al inicio del juego.
      const startBase = s.comboStartFrame != null
        ? s.comboStartFrame - 4 * 60
        : s.frame - 8 * 60;
      items.push({
        gamePath: g.path,
        stockId: s.id,
        stage: g.stage,
        gameDate: null, // se completa en cada endpoint
        frame: s.frame,
        timeSeconds: s.timeSeconds,
        comboLength: s.comboLength,
        killMove: s.killMove ?? null,
        killMoveId: s.killMoveId ?? null,
        comboMoves: s.comboMoves ?? null,
        // false = cache viejo sin secuencia de golpes (contains/starts no aplican)
        movesKnown: Array.isArray(s.comboMoves),
        killPercent: s.killPercent ?? null,
        score: s.score,
        player: killer ? { connectCode: killer.connectCode, characterId: killer.characterId } : null,
        opponent: victim ? { connectCode: victim.connectCode, characterId: victim.characterId } : null,
        startFrame: Math.max(SLIPPI_FIRST_FRAME, Math.round(startBase)),
        endFrame: Math.round(s.frame + 2 * 60),
      });
    }
  }
  items.sort((a, b) => (b.comboLength - a.comboLength) || (b.score - a.score));
  return items;
}

function topCombosParams(req) {
  return {
    limit: Math.min(50, Math.max(1, Number(req.query.limit) || 10)),
    minHits: Math.max(1, Number(req.query.minHits) || 3),
    custom: req.query.custom === '1' || req.query.custom === 'true',
  };
}

// Aplica el ranking personalizado (reglas guardadas) si custom=1 y hay reglas.
function maybeCustomRank(items, custom) {
  if (!custom) return items;
  const { rules } = comboRanking.loadRules();
  if (rules.length === 0) return items;
  return comboRanking.applyCustomRanking(items, rules);
}

// GET /api/moves — catálogo de golpes de slippi-js para el builder de reglas.
// Los moveIds son genéricos (Neutral B = 18 para todos los personajes).
app.get('/api/moves', (req, res) => {
  const list = [];
  for (let id = 1; id <= 90; id++) {
    const name = slippiMoves.getMoveName(id);
    if (!name || name === 'Unknown Move') continue;
    list.push({ id, name, shortName: slippiMoves.getMoveShortName(id) });
  }
  res.json({ moves: list });
});

// GET/PUT /api/combo-ranking — reglas de ranking personalizado (orden=prioridad)
app.get('/api/combo-ranking', (req, res) => {
  res.json(comboRanking.loadRules());
});

app.put('/api/combo-ranking', (req, res) => {
  try {
    const rules = comboRanking.saveRules(req.body?.rules);
    res.json({ ok: true, rules });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/top-combos — ranking global sobre el cache de stocks en disco
app.get('/api/top-combos', (req, res) => {
  const { limit, minHits, custom } = topCombosParams(req);
  try {
    let raw = {};
    if (fs.existsSync(STOCKS_CACHE_FILE)) {
      raw = JSON.parse(fs.readFileSync(STOCKS_CACHE_FILE, 'utf-8'));
    }
    const gamesStocks = Object.values(raw).filter((e) => e && e.data).map((e) => e.data);
    const gamesCache = loadCachedGames() || { games: [] };
    const dateByPath = new Map(gamesCache.games.map((g) => [g.filePath, g.date || g.startAt || null]));
    const items = maybeCustomRank(topComboItems(gamesStocks, minHits), custom).slice(0, limit).map((it) => ({
      ...it,
      gameDate: dateByPath.get(it.gamePath) || gameDateFromName(it.gamePath),
    }));
    res.json({ items, coverage: { analyzed: gamesStocks.length, total: gamesCache.games.length } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sets/:id/top-combos — ranking scoped a los juegos del set
app.get('/api/sets/:id/top-combos', (req, res) => {
  const set = setsStore.getSet(req.params.id);
  if (!set) return res.status(404).json({ error: 'Set no encontrado' });
  const { limit, minHits, custom } = topCombosParams(req);
  try {
    const { games, errors } = getSetStocks(set);
    // gameIndex: posición del juego dentro del set (0-based) para mostrar G1, G2...
    const gameIndexByPath = new Map((set.gamePaths || []).map((p, i) => [p, i]));
    const items = maybeCustomRank(topComboItems(games, minHits), custom).slice(0, limit).map((it) => ({
      ...it,
      gameDate: gameDateFromName(it.gamePath),
      gameIndex: gameIndexByPath.has(it.gamePath) ? gameIndexByPath.get(it.gamePath) : null,
    }));
    res.json({
      items,
      coverage: { analyzed: games.length, total: (set.gamePaths || []).length },
      ...(errors.length ? { errors } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scan global de stocks: job 'compute-stocks' en la cola SQLite. Como
// CONCURRENT_JOBS=1, no corre a la vez que un render/set-export; el cache
// salta los juegos frescos, así que es resumible.
function findActiveStocksScan() {
  for (const status of ['running', 'pending']) {
    const job = jobQueue.list({ status, limit: 100 }).find((j) => j.type === 'compute-stocks');
    if (job) return job;
  }
  return null;
}

// POST /api/top-combos/scan — encola el scan (409 si ya hay uno activo)
app.post('/api/top-combos/scan', (req, res) => {
  const active = findActiveStocksScan();
  if (active) {
    return res.status(409).json({ message: 'Scan de stocks ya en curso o en cola', jobId: active.id });
  }
  const jobId = jobQueue.add('compute-stocks', {}, { maxRetries: 0 });
  console.log('[top-combos] Scan de stocks encolado:', jobId);
  res.json({ ok: true, jobId });
});

// GET /api/top-combos/scan — estado del scan activo o del último ejecutado
app.get('/api/top-combos/scan', (req, res) => {
  const active = findActiveStocksScan();
  const job = active || jobQueue.list({ limit: 50 }).find((j) => j.type === 'compute-stocks');
  if (!job) return res.json({ status: 'idle', progress: null });
  res.json({ status: job.status, jobId: job.id, progress: job.progress || null, error: job.error || null });
});

// ---------- Auto-shorts (reels automáticos rankeados por reglas + ELO) ----------

// Vista de candidato para el preview del dashboard (sin frames ni moves).
function autoShortCandidateView(it) {
  return {
    gamePath: it.gamePath,
    stockId: it.stockId,
    stage: it.stage,
    gameDate: it.gameDate,
    comboLength: it.comboLength,
    killMove: it.killMove,
    killPercent: it.killPercent,
    score: it.baseScore ?? it.score,
    rating: it.rating,
    displayName: it.displayName,
    eloBonus: it.eloBonus,
    finalScore: it.finalScore,
    player: it.player,
    opponent: it.opponent,
  };
}

// GET /api/auto-shorts — config + history (estado resuelto) + preview de
// candidatos actuales (top 10, sin generar nada).
app.get('/api/auto-shorts', async (req, res) => {
  try {
    const config = autoShorts.getConfig();
    const candidates = await autoShorts.collectCandidates(config);
    const activeJob = autoShorts.findActiveAutoShortJob(jobQueue);
    res.json({
      config: { ...config, history: undefined },
      history: autoShorts.resolveHistory(jobQueue).slice().reverse(),
      candidates: candidates.slice(0, 10).map(autoShortCandidateView),
      candidateCount: candidates.length,
      activeJobId: activeJob?.id || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auto-shorts — actualiza config (valida rangos)
app.put('/api/auto-shorts', (req, res) => {
  try {
    const config = autoShorts.updateConfig(req.body || {});
    console.log('[auto-shorts] Config actualizada:', JSON.stringify({ ...config, history: undefined }));
    res.json({ ok: true, config: { ...config, history: undefined } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/auto-shorts/generate — fuerza generación manual
// (409 si ya hay un auto-short renderizando/en cola, 422 si faltan candidatos)
app.post('/api/auto-shorts/generate', async (req, res) => {
  try {
    const result = await autoShorts.generateAutoShort(jobQueue, 'manual');
    console.log('[auto-shorts] Generación manual encolada:', result.jobId, result.title);
    res.json({ ok: true, ...result });
  } catch (err) {
    const code = err.statusCode || 500;
    res.status(code).json({ error: err.message });
  }
});

// POST /api/sets/:id/export — encola UN job compuesto (full-set o reel)
app.post('/api/sets/:id/export', (req, res) => {
  const set = setsStore.getSet(req.params.id);
  if (!set) return res.status(404).json({ error: 'Set no encontrado' });

  const { type, items: rawItems, targetDurationSec, vertical, leadSeconds, music: rawMusic } = req.body || {};
  if (type !== 'full-set' && type !== 'reel') {
    return res.status(400).json({ error: 'type debe ser "full-set" o "reel"' });
  }

  let music;
  try {
    music = parseMusicParam(rawMusic);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let items;
  let contentSeconds = 0;
  if (type === 'full-set') {
    items = (set.gamePaths || []).map((gamePath) => ({ gamePath }));
    const cache = loadCachedGames() || { games: [] };
    const durationByPath = new Map(cache.games.map((g) => [g.filePath, g.duration || 0]));
    contentSeconds = items.reduce((sum, it) => sum + (durationByPath.get(it.gamePath) || 240), 0);
  } else {
    if (Array.isArray(rawItems) && rawItems.length > 0) {
      items = rawItems
        .filter((it) => it && it.gamePath && it.stockId)
        .map((it) => ({
          gamePath: it.gamePath,
          stockId: String(it.stockId),
          // Frames custom opcionales (preview ajustado por el usuario).
          ...(Number.isFinite(it.startFrame) && Number.isFinite(it.endFrame) && it.endFrame > it.startFrame
            ? { startFrame: Math.round(Number(it.startFrame)), endFrame: Math.round(Number(it.endFrame)) }
            : {}),
        }));
      if (items.length === 0) return res.status(400).json({ error: 'items inválidos (gamePath + stockId)' });
    } else if (targetDurationSec) {
      // Auto-selección: stocks con mayor score hasta llenar la duración objetivo.
      try {
        items = selectStocksForDuration(getSetStocks(set), Number(targetDurationSec));
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
      if (items.length === 0) return res.status(400).json({ error: 'No hay stocks para auto-seleccionar' });
    } else {
      return res.status(400).json({ error: 'Para reel envía items[] o targetDurationSec' });
    }
    contentSeconds = items.length * estimateStockClipSeconds();
  }

  const payload = {
    setId: set.id,
    name: set.name,
    type,
    items,
    targetDurationSec: targetDurationSec || null,
    vertical: !!vertical, // guardado para futuro formato shorts; hoy renderiza 4:3
    leadSeconds: Math.max(0, Math.min(60, Number(leadSeconds) || 0)), // contexto extra antes del combo
    music, // pista de music/ mezclada al final (null = sin música)
  };
  const jobId = jobQueue.add('set-export', payload);

  // Render aproximadamente en tiempo real (x1.5 de margen) para la estimación.
  const estimatedMinutes = Math.max(1, Math.ceil((contentSeconds * 1.5) / 60));
  notifySetQueued({ name: set.name, type, itemCount: items.length, estimatedMinutes }).catch(() => {});

  res.json({ ok: true, jobId, itemCount: items.length, estimatedMinutes });
});

// ---------- Scheduler de contenido (schedule.json) ----------

// Entry con campos calculados para el dashboard.
function scheduleEntryView(entry) {
  const renderEstimateSec = scheduler.estimateRenderSec(entry);
  return {
    ...entry,
    renderEstimateSec,
    renderStartAt: scheduler.renderStartAt(entry).toISOString(),
  };
}

// GET /api/schedule — entries ordenadas por publishAt asc
app.get('/api/schedule', (req, res) => {
  res.json({ entries: scheduler.listEntries().map(scheduleEntryView) });
});

// GET /api/uploads — videos del canal (YouTube API, cache 10 min) enriquecidos
// con la metadata local de schedule.json (set, tipo, descripción original).
// Query: refresh=1 para saltar el cache de YouTube.
app.get('/api/uploads', async (req, res) => {
  try {
    const { fetchedAt, videos } = await ytChannel.listChannelUploads({
      force: req.query.refresh === '1',
    });
    const byVideoId = new Map();
    for (const e of scheduler.listEntries()) {
      if (!e.youtubeUrl) continue;
      const m = String(e.youtubeUrl).match(/(?:youtu\.be\/|v=)([\w-]{11})/);
      if (m) byVideoId.set(m[1], e);
    }
    const merged = videos.map((v) => {
      const local = byVideoId.get(v.videoId);
      return {
        ...v,
        local: local
          ? {
              scheduleId: local.id,
              setId: local.setId || null,
              setName: local.name || null,
              type: local.type || null,
              clipCount: Array.isArray(local.items) ? local.items.length : null,
              vertical: Boolean(local.vertical),
              outputPath: local.outputPath || null,
            }
          : null,
      };
    });
    res.json({ fetchedAt, videos: merged });
  } catch (err) {
    console.error('[uploads] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedule con exportJobId — programa SOLO la subida de un export
// ya renderizado (job set-export completado), sin re-render. La entry nace
// en status 'rendered' y el tick la sube cuando llega publishAt.
function scheduleExistingExport(req, res) {
  const { exportJobId, publishAt, title, description, tags } = req.body || {};

  const job = jobQueue.get(exportJobId);
  if (!job) return res.status(404).json({ error: `Job ${exportJobId} no encontrado en la cola` });
  if (job.type !== 'set-export') {
    return res.status(400).json({ error: `El job ${exportJobId} es tipo "${job.type}", no set-export` });
  }
  const result = job.progress && job.progress.phase === 'done' ? job.progress : null;
  if (job.status !== 'completed' || !result) {
    return res.status(400).json({ error: `El job ${exportJobId} no es un export completado (status: ${job.status})` });
  }
  const outputPath = result.outputPath;
  if (!outputPath || !fs.existsSync(outputPath)) {
    return res.status(400).json({ error: `El archivo renderizado ya no existe: ${outputPath || '(desconocido)'}` });
  }

  const publishMs = Date.parse(publishAt);
  if (!publishAt || !Number.isFinite(publishMs)) {
    return res.status(400).json({ error: 'publishAt inválido (ISO 8601)' });
  }
  if (publishMs <= Date.now()) {
    return res.status(400).json({ error: 'publishAt debe ser una fecha futura' });
  }

  // No dos entries activas para el mismo export.
  const ACTIVE = ['scheduled', 'rendering', 'rendered', 'uploading'];
  const dupe = scheduler.listEntries().find((e) => e.jobId === exportJobId && ACTIVE.includes(e.status));
  if (dupe) {
    return res.status(409).json({ error: `Ya existe una entry activa (${dupe.id}, status ${dupe.status}) para este export` });
  }

  const payload = job.payload || {};
  const type = payload.type === 'full-set' ? 'full-set' : 'reel';
  const name = payload.name || 'Set';
  const set = payload.setId ? setsStore.getSet(payload.setId) : null;

  // Metadata: lo que venga en el body; si falta, generar con generateMetadata.
  let metadata = { title, description, tags };
  if (!title || !description || !Array.isArray(tags)) {
    try {
      const generated = generateMetadata({ set, type, items: payload.items || [], name });
      metadata = {
        title: title || generated.title,
        description: description || generated.description,
        tags: Array.isArray(tags) ? tags : generated.tags,
      };
    } catch (err) {
      return res.status(500).json({ error: `No se pudo generar metadata: ${err.message}` });
    }
  }

  const entry = scheduler.createEntry({
    setId: payload.setId || null,
    name,
    type,
    items: type === 'reel' ? (payload.items || []) : null,
    vertical: !!payload.vertical,
    leadSeconds: payload.leadSeconds,
    publishAt: new Date(publishMs).toISOString(),
    title: metadata.title,
    description: metadata.description,
    tags: metadata.tags,
    status: 'rendered',
    jobId: exportJobId,
    outputPath,
  });
  res.json({ ok: true, entry: scheduleEntryView(entry) });
}

// POST /api/schedule — programa un export (reel o full-set) para publicar,
// o (con exportJobId) solo la subida de un export ya renderizado.
app.post('/api/schedule', (req, res) => {
  if (req.body && req.body.exportJobId) return scheduleExistingExport(req, res);
  const { setId, type, items: rawItems, targetDurationSec, vertical, leadSeconds, publishAt, title, description, tags, music: rawMusic } = req.body || {};

  const set = setsStore.getSet(setId);
  if (!set) return res.status(404).json({ error: 'Set no encontrado' });
  if (type !== 'full-set' && type !== 'reel') {
    return res.status(400).json({ error: 'type debe ser "full-set" o "reel"' });
  }
  let music;
  try {
    music = parseMusicParam(rawMusic);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const publishMs = Date.parse(publishAt);
  if (!publishAt || !Number.isFinite(publishMs)) {
    return res.status(400).json({ error: 'publishAt inválido (ISO 8601)' });
  }
  if (publishMs <= Date.now()) {
    return res.status(400).json({ error: 'publishAt debe ser una fecha futura' });
  }

  let items = null;
  if (type === 'reel') {
    if (Array.isArray(rawItems) && rawItems.length > 0) {
      items = rawItems
        .filter((it) => it && it.gamePath && it.stockId)
        .map((it) => ({
          gamePath: it.gamePath,
          stockId: String(it.stockId),
          // Frames custom opcionales (preview ajustado por el usuario).
          ...(Number.isFinite(it.startFrame) && Number.isFinite(it.endFrame) && it.endFrame > it.startFrame
            ? { startFrame: Math.round(Number(it.startFrame)), endFrame: Math.round(Number(it.endFrame)) }
            : {}),
        }));
      if (items.length === 0) return res.status(400).json({ error: 'items inválidos (gamePath + stockId)' });
    } else if (targetDurationSec) {
      // Auto-selección: stocks con mayor score hasta llenar la duración objetivo.
      try {
        items = selectStocksForDuration(getSetStocks(set), Number(targetDurationSec));
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
      if (items.length === 0) return res.status(400).json({ error: 'No hay stocks para auto-seleccionar' });
    } else {
      return res.status(400).json({ error: 'Para reel envía items[] o targetDurationSec' });
    }
  }

  // Metadata de YouTube: si no viene, se genera igual que en set-export.
  let metadata = { title, description, tags };
  if (!title || !description || !Array.isArray(tags)) {
    try {
      const generated = generateMetadata({
        set,
        type,
        items: type === 'reel' ? items : (set.gamePaths || []).map((gamePath) => ({ gamePath })),
        name: set.name,
      });
      metadata = {
        title: title || generated.title,
        description: description || generated.description,
        tags: Array.isArray(tags) ? tags : generated.tags,
      };
    } catch (err) {
      return res.status(500).json({ error: `No se pudo generar metadata: ${err.message}` });
    }
  }

  const entry = scheduler.createEntry({
    setId: set.id,
    name: set.name,
    type,
    items,
    targetDurationSec: targetDurationSec || null,
    vertical,
    leadSeconds,
    music, // pista de music/ mezclada en el render (null = sin música)
    publishAt: new Date(publishMs).toISOString(),
    title: metadata.title,
    description: metadata.description,
    tags: metadata.tags,
  });
  res.json({ ok: true, entry: scheduleEntryView(entry) });
});

// PUT /api/schedule/:id — editar title/description/tags/publishAt
app.put('/api/schedule/:id', (req, res) => {
  const entry = scheduler.getEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry no encontrada' });
  if (entry.status === 'uploading' || entry.status === 'uploaded') {
    return res.status(409).json({ error: `No se puede editar una entry en estado ${entry.status}` });
  }

  const { title, description, tags, publishAt } = req.body || {};
  const patch = {};
  if (title !== undefined) patch.title = String(title);
  if (description !== undefined) patch.description = String(description);
  if (tags !== undefined) {
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags debe ser un array' });
    patch.tags = tags.map(String);
  }
  if (publishAt !== undefined) {
    // publishAt solo se mueve antes de encolar el render; si ya renderizó,
    // como mucho se puede adelantar (nunca al pasado).
    if (entry.status !== 'scheduled') {
      return res.status(409).json({ error: 'publishAt solo se puede cambiar en estado scheduled' });
    }
    const publishMs = Date.parse(publishAt);
    if (!Number.isFinite(publishMs)) return res.status(400).json({ error: 'publishAt inválido (ISO 8601)' });
    if (publishMs <= Date.now()) return res.status(400).json({ error: 'publishAt debe ser una fecha futura' });
    patch.publishAt = new Date(publishMs).toISOString();
    patch.error = null;
  }

  const updated = scheduler.updateEntry(entry.id, patch);
  res.json({ ok: true, entry: scheduleEntryView(updated) });
});

// DELETE /api/schedule/:id — eliminar (cancela el job si está renderizando)
app.delete('/api/schedule/:id', (req, res) => {
  const entry = scheduler.getEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry no encontrada' });
  if (entry.status === 'rendering' && entry.jobId) {
    jobQueue.cancel(entry.jobId);
  }
  scheduler.deleteEntry(entry.id);
  res.json({ ok: true });
});

// GET /api/dashboard — juegos ya procesados
app.get('/api/dashboard', (req, res) => {
  res.json({ generatedAt: new Date().toISOString(), games: loadProcessedGames() });
});

// Discord recording endpoints
app.post('/api/discord/start', async (req, res) => {
  const { guildId, channelId, userId } = req.body;
  if (!guildId || !channelId) {
    return res.status(400).json({ error: 'Faltan guildId o channelId' });
  }
  try {
    const config = loadDashboardConfig();
    config.discordGuildId = guildId;
    config.discordChannelId = channelId;
    addDiscordHistory(config, guildId, channelId);
    saveDashboardConfig(config);
    const result = await startRecording(guildId, channelId, userId);
    res.json({ message: 'Grabacion iniciada', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/discord/stop', async (req, res) => {
  try {
    const result = await stopRecording();
    res.json({ message: 'Grabacion finalizada', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function findOverlappingGames(recording, games) {
  if (!recording.startEpoch) return [];
  const recStart = recording.startEpoch;
  const recEnd = recStart + (recording.durationSeconds || 0) * 1000;
  return games.filter((g) => gameOverlapsRecording(g, recording));
}

function gameOverlapsRecording(game, recording) {
  if (!recording.startEpoch || !game.startTimestamp) return false;
  const recStart = recording.startEpoch;
  const recEnd = recStart + (recording.durationSeconds || 0) * 1000;
  const gameStart = game.startTimestamp;
  const gameEnd = gameStart + (game.duration || 0) * 1000;
  return gameStart <= recEnd && gameEnd >= recStart;
}

app.get('/api/discord/recordings', (req, res) => {
  const cache = loadCachedGames() || { games: [] };
  const recordings = getRecordings().map((rec) => ({
    id: rec.file,
    file: rec.file,
    path: rec.path,
    startEpoch: rec.startEpoch,
    durationSeconds: rec.durationSeconds,
    channelName: rec.channelName,
    userIds: rec.userIds,
    startedAt: new Date(rec.startEpoch).toISOString(),
    stoppedAt: rec.durationSeconds
      ? new Date(rec.startEpoch + rec.durationSeconds * 1000).toISOString()
      : undefined,
    overlappingGames: findOverlappingGames(rec, cache.games),
  }));
  res.json({ active: isRecording(), recordings });
});

app.delete('/api/discord/recordings/:file', (req, res) => {
  const file = req.params.file;
  if (!file || !/^voice_\d+\.wav$/.test(file)) {
    return res.status(400).json({ error: 'Nombre de archivo inválido' });
  }
  const deleted = deleteRecording(file);
  if (!deleted) {
    return res.status(404).json({ error: 'Grabación no encontrada' });
  }
  res.json({ ok: true, message: 'Grabación eliminada' });
});

// Sesión automática: Discord + detección de .slp nuevos
app.post('/api/session/start', async (req, res) => {
  const { guildId, channelId, options = {} } = req.body;
  if (!guildId || !channelId) {
    return res.status(400).json({ error: 'Faltan guildId o channelId' });
  }
  try {
    const config = loadDashboardConfig();
    config.discordGuildId = guildId;
    config.discordChannelId = channelId;
    addDiscordHistory(config, guildId, channelId);
    saveDashboardConfig(config);
    const result = await startAutoSession(guildId, channelId, {
      sendTelegram: !!options.sendTelegram,
      copyToMac: !!options.copyToMac,
      mixDiscord: !!options.mixDiscord,
      paddingBefore: Number(options.paddingBefore || 7),
      paddingAfter: Number(options.paddingAfter || 2),
    });
    notifySessionStarted({ guildId, channelId }).catch(() => {});
    res.json({ message: 'Sesión iniciada', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/session/stop', async (req, res) => {
  try {
    const result = await stopAutoSession();
    notifySessionStopped({ recordedSeconds: result?.recordedSeconds }).catch(() => {});
    res.json({ message: 'Sesión finalizada', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/session', (req, res) => {
  res.json({ session: getSession(), replaysDir: REPLAYS_DIR });
});

app.get('/api/config', (req, res) => {
  const config = loadDashboardConfig();
  res.json({
    replaysDir: REPLAYS_DIR,
    discordGuildId: config.discordGuildId || '',
    discordChannelId: config.discordChannelId || '',
    history: config.history || [],
    // Medido de los clips renderizados (clips-montage/compilations): ~47.7 MB/min.
    // Se usa para estimar el peso del video final en el export bar.
    estimatedMbPerMin: Number(process.env.ESTIMATED_MB_PER_MIN || '48'),
  });
});

app.post('/api/config', (req, res) => {
  const { discordGuildId, discordChannelId } = req.body || {};
  const config = loadDashboardConfig();
  if (discordGuildId !== undefined) config.discordGuildId = String(discordGuildId);
  if (discordChannelId !== undefined) config.discordChannelId = String(discordChannelId);
  addDiscordHistory(config, config.discordGuildId, config.discordChannelId);
  saveDashboardConfig(config);
  res.json({ ok: true, discordGuildId: config.discordGuildId, discordChannelId: config.discordChannelId, history: config.history });
});

// GET /api/stocks — stocks detectados de un juego
app.get('/api/stocks', (req, res) => {
  const slpPath = req.query.slp;
  const attackerIndex = parseInt(req.query.attacker, 10);
  const victimIndex = parseInt(req.query.victim, 10);
  if (!slpPath || isNaN(attackerIndex) || isNaN(victimIndex)) {
    return res.status(400).json({ error: 'Faltan parámetros: slp, attacker, victim' });
  }
  try {
    const data = detectStocks(slpPath, attackerIndex, victimIndex);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function findRecordingCoveringSegment(segmentStart, segmentEnd) {
  const recordings = getRecordings();
  let best = null;
  let bestCoverage = -1;
  for (const rec of recordings) {
    if (!rec.startEpoch) continue;
    const recStart = rec.startEpoch;
    const recEnd = recStart + (rec.durationSeconds || 0) * 1000;
    const overlapStart = Math.max(segmentStart, recStart);
    const overlapEnd = Math.min(segmentEnd, recEnd);
    const coverage = Math.max(0, overlapEnd - overlapStart);
    if (coverage > bestCoverage) {
      bestCoverage = coverage;
      best = { rec, recStart, recEnd, overlapStart, overlapEnd };
    }
  }
  return bestCoverage > 0 ? best : null;
}

// GET /api/audio-preview — extrae el audio de Discord correspondiente a un stock
app.get('/api/audio-preview', async (req, res) => {
  const slpPath = req.query.slp;
  const attackerIndex = parseInt(req.query.attacker, 10);
  const victimIndex = parseInt(req.query.victim, 10);
  const stockIndex = parseInt(req.query.stockIndex, 10);
  const paddingBefore = Number(req.query.paddingBefore || 7);
  const paddingAfter = Number(req.query.paddingAfter || 2);

  if (!slpPath || isNaN(attackerIndex) || isNaN(victimIndex) || isNaN(stockIndex)) {
    return res.status(400).json({ error: 'Faltan parámetros' });
  }

  try {
    const game = new SlippiGame(slpPath);
    const meta = game.getMetadata();
    if (!meta || !meta.startAt) {
      return res.status(404).json({ error: 'No se pudo leer startAt del replay' });
    }
    const gameStartMs = new Date(meta.startAt).getTime();

    const stocksData = detectStocks(slpPath, attackerIndex, victimIndex);
    const stock = stocksData.stocksAtoB.find((s) => s.index === stockIndex);
    if (!stock) {
      return res.status(404).json({ error: 'Stock no encontrado' });
    }

    const stockStartMs = gameStartMs + (stock.timeSeconds - paddingBefore) * 1000;
    const stockEndMs = gameStartMs + (stock.timeSeconds + paddingAfter) * 1000;

    const match = findRecordingCoveringSegment(stockStartMs, stockEndMs);
    if (!match) {
      return res.status(404).json({ error: 'No hay grabación de Discord que cubra este stock' });
    }

    const offsetSeconds = Math.max(0, (stockStartMs - match.recStart) / 1000);
    const durationSeconds = Math.max(1, (match.overlapEnd - match.overlapStart) / 1000);

    const baseName = path.basename(match.rec.file, '.wav');
    const outputName = `${baseName}_stock${stockIndex}_${paddingBefore}_${paddingAfter}.wav`;
    const outputPath = path.join(PREVIEWS_DIR, outputName);

    if (!fs.existsSync(outputPath)) {
      await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', [
          '-y',
          '-i', match.rec.path,
          '-ss', String(offsetSeconds),
          '-t', String(durationSeconds),
          '-acodec', 'pcm_s16le',
          '-ar', '48000',
          '-ac', '2',
          outputPath,
        ], { stdio: 'ignore' });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg salió con código ${code}`));
        });
        proc.on('error', reject);
      });
    }

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `inline; filename="${outputName}"`);
    fs.createReadStream(outputPath).pipe(res);
  } catch (err) {
    console.error('[audio-preview] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/video-preview — renderiza un stock en baja calidad para calibrar audio
app.get('/api/video-preview', async (req, res) => {
  const slpPath = req.query.slp;
  const attackerIndex = parseInt(req.query.attacker, 10);
  const victimIndex = parseInt(req.query.victim, 10);
  const stockIndex = parseInt(req.query.stockIndex, 10);
  const paddingBefore = Number(req.query.paddingBefore || 7);
  const paddingAfter = Number(req.query.paddingAfter || 2);
  const mixDiscord = req.query.mixDiscord === '1' || req.query.mixDiscord === 'true';
  const discordAudioOffset = Number(req.query.discordAudioOffset || 0);
  // Calidad de preview rápida por defecto
  const resolution = req.query.resolution || '480p';
  const bitrate = req.query.bitrate ? Number(req.query.bitrate) : 8000;
  const widescreen = req.query.widescreen === '1' || req.query.widescreen === 'true';

  if (!slpPath || isNaN(attackerIndex) || isNaN(victimIndex) || isNaN(stockIndex)) {
    return res.status(400).json({ error: 'Faltan parámetros' });
  }

  // Solo un preview a la vez para no saturar el servidor.
  if (activePreview) {
    return res.status(429).json({ error: 'Ya hay un preview en curso. Espera a que termine o recarga la página.' });
  }

  let previewChild = null;
  let clientDisconnected = false;

  const cleanupPreview = () => {
    if (previewChild && !previewChild.killed) {
      try {
        previewChild.kill('SIGTERM');
        setTimeout(() => {
          if (previewChild && !previewChild.killed) previewChild.kill('SIGKILL');
        }, 3000);
      } catch (e) {
        // ignore
      }
    }
    activePreview = null;
  };

  req.on('close', () => {
    clientDisconnected = true;
    cleanupPreview();
  });

  try {
    const game = new SlippiGame(slpPath);
    const settings = game.getSettings();
    const meta = game.getMetadata();
    if (!meta || !meta.startAt) {
      return res.status(404).json({ error: 'No se pudo leer startAt del replay' });
    }

    const stocksData = detectStocks(slpPath, attackerIndex, victimIndex);
    const stock = stocksData.stocksAtoB.find((s) => s.index === stockIndex);
    if (!stock) {
      return res.status(404).json({ error: 'Stock no encontrado' });
    }

    const startFrame = settings.startFrame ?? -123;
    const lastFrame = settings.lastFrame ?? game.getLatestFrame().frame ?? 999999;
    const leadFrames = Math.round(paddingBefore * 60);
    const padFrames = Math.round(paddingAfter * 60);
    const clipStart = Math.max(startFrame, stock.frame - leadFrames);
    const clipEnd = Math.min(lastFrame, stock.frame + padFrames);

    const baseName = path.basename(slpPath, '.slp');
    const clipName = `${baseName}_stock${stockIndex}_preview`;
    const outputFile = path.join(PREVIEWS_DIR, `${clipName}.mp4`);

    // Renderizar de forma async para no bloquear el event loop.
    const { promise, child } = cutClipAsync(
      slpPath,
      { startFrame: clipStart, endFrame: clipEnd, reason: `preview stock ${stockIndex}` },
      clipName,
      { resolution, bitrate, widescreen, timeoutMs: 5 * 60 * 1000 },
      PREVIEWS_DIR
    );
    previewChild = child;
    activePreview = { child, startTime: Date.now() };

    const rendered = await promise;

    if (clientDisconnected) {
      cleanupPreview();
      return;
    }

    let finalFile = rendered;
    if (mixDiscord) {
      const mixedOutput = rendered.replace('.mp4', '_mixed.mp4');
      const result = mixDiscordAudioForClip(slpPath, stock.frame, rendered, mixedOutput, paddingBefore, discordAudioOffset);
      if (result.used) {
        finalFile = mixedOutput;
      }
    }

    if (clientDisconnected) {
      cleanupPreview();
      return;
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(finalFile)}"`);
    const stream = fs.createReadStream(finalFile);
    stream.on('close', () => {
      activePreview = null;
    });
    stream.pipe(res);
  } catch (err) {
    cleanupPreview();
    if (!clientDisconnected && !res.headersSent) {
      console.error('[video-preview] Error:', err);
      res.status(500).json({ error: err.message });
    }
  }
});

// ── Previews MP4 livianos (cacheados, via cola SQLite) ─────────────────────

// POST /api/previews — body {gamePath, startFrame, endFrame}
// Devuelve {id, status, cached, etaSec}. Si no está cacheado, encola job 'preview'
// (el worker procesa de a uno: nunca dos renders en paralelo).

// Estimación de segundos de render por job, calibrada con renders reales:
// previews ~3.5x realtime + overhead de arranque de Dolphin (~8s);
// reels ~150s por clip; full-set ~300s por juego.
function estimateJobSeconds(job) {
  const p = job.payload || {};
  if (job.type === 'preview') {
    const clipSec = Math.max(1, ((p.endFrame || 0) - (p.startFrame || 0)) / 60);
    return Math.round(clipSec * 3.5 + 8);
  }
  if (job.type === 'set-export') {
    if (job.progress && typeof job.progress.etaSec === 'number') return job.progress.etaSec;
    const n = (p.items || []).length || 1;
    return p.type === 'full-set' ? n * 300 : n * 150;
  }
  return 60;
}

// Segundos que faltan para que un job empiece (cola secuencial): lo que le
// falta al job en curso + los estimados de los pendientes delante de él.
function queueWaitSeconds(beforeJobId) {
  let wait = 0;
  const running = jobQueue.getRunning();
  if (running) {
    const elapsed = running.startedAt ? (Date.now() - new Date(running.startedAt).getTime()) / 1000 : 0;
    wait += running.id === beforeJobId ? 0 : Math.max(5, estimateJobSeconds(running) - elapsed);
  }
  for (const j of jobQueue.list({ status: 'pending', limit: 100 })) {
    if (j.id === beforeJobId) break;
    wait += estimateJobSeconds(j);
  }
  return Math.round(wait);
}

// ETA total de un job de preview (espera de cola + render propio).
function previewJobEta(job) {
  if (!job) return null;
  const own = estimateJobSeconds(job);
  if (job.status === 'running') {
    const elapsed = job.startedAt ? (Date.now() - new Date(job.startedAt).getTime()) / 1000 : 0;
    return Math.max(5, Math.round(own - elapsed));
  }
  if (job.status === 'pending') return queueWaitSeconds(job.id) + own;
  return null;
}

app.post('/api/previews', (req, res) => {
  const { gamePath, startFrame, endFrame } = req.body || {};
  const start = Number(startFrame);
  const end = Number(endFrame);
  if (!gamePath || typeof gamePath !== 'string' || !gamePath.endsWith('.slp')) {
    return res.status(400).json({ error: 'gamePath inválido (debe ser .slp)' });
  }
  if (!fs.existsSync(gamePath)) {
    return res.status(404).json({ error: `No existe el archivo: ${gamePath}` });
  }
  if (!isFinite(start) || !isFinite(end) || end <= start) {
    return res.status(400).json({ error: 'startFrame/endFrame inválidos' });
  }

  const id = previewRender.previewIdFor(gamePath, start, end);
  if (previewRender.getCachedPath(id)) {
    return res.json({ id, status: 'done', cached: true, etaSec: 0 });
  }

  // ¿Ya hay un job vivo para este preview?
  const entry = previewRender.getPreview(id);
  if (entry && entry.jobId) {
    const existing = jobQueue.get(entry.jobId);
    if (existing && (existing.status === 'pending' || existing.status === 'running')) {
      return res.json({
        id,
        status: existing.status === 'running' ? 'rendering' : 'pending',
        cached: false,
        etaSec: previewJobEta(existing),
      });
    }
  }

  const jobId = jobQueue.add('preview', { id, gamePath, startFrame: start, endFrame: end });
  previewRender.registerPreview({ id, gamePath, startFrame: start, endFrame: end, jobId, status: 'pending', createdAt: new Date().toISOString() });
  res.json({ id, status: 'pending', cached: false, etaSec: previewJobEta(jobQueue.get(jobId)) });
});

// GET /api/previews/:id — estado del preview
app.get('/api/previews/:id', (req, res) => {
  const { id } = req.params;
  if (previewRender.getCachedPath(id)) {
    return res.json({ id, status: 'done', url: `/api/previews/${id}/file` });
  }
  const entry = previewRender.getPreview(id);
  if (!entry) return res.status(404).json({ error: 'Preview no encontrado' });

  const job = entry.jobId ? jobQueue.get(entry.jobId) : null;
  if (!job) return res.json({ id, status: 'pending', url: `/api/previews/${id}/file` });
  if (job.status === 'running') {
    return res.json({ id, status: 'rendering', url: `/api/previews/${id}/file`, progress: job.progress || undefined, etaSec: previewJobEta(job) });
  }
  if (job.status === 'pending') {
    return res.json({ id, status: 'pending', url: `/api/previews/${id}/file`, etaSec: previewJobEta(job) });
  }
  // completed sin archivo, failed o cancelled -> error
  return res.json({
    id,
    status: 'error',
    error: job.status === 'completed' ? 'Job completado pero el archivo no existe' : (job.error || `Job ${job.status}`),
  });
});

// GET /api/previews/:id/file — stream del mp4 con soporte Range (seeking)
app.get('/api/previews/:id/file', (req, res) => {
  const filePath = previewRender.getCachedPath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'Preview no renderizado todavía' });
  // res.sendFile soporta Range/206 nativamente.
  res.sendFile(filePath, { acceptRanges: true }, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: err.message });
  });
});

// GET /api/previews?gamePath=... — previews cacheados de un juego
app.get('/api/previews', (req, res) => {
  const previews = previewRender
    .listPreviews(req.query.gamePath || null)
    .filter((p) => p.cached)
    .map((p) => ({
      id: p.id,
      gamePath: p.gamePath,
      startFrame: p.startFrame,
      endFrame: p.endFrame,
      createdAt: p.createdAt,
      url: `/api/previews/${p.id}/file`,
    }));
  res.json({ previews });
});

// GET /api/exports — historial de exports completados (reels y full-sets),
// cruzado con approvals.json para saber título y si ya subió a YouTube, con
// schedule.json para saber si tiene una publicación programada activa, y con
// thumbnails/ para saber si tiene thumbnail asignado.
const SCHED_ACTIVE = ['scheduled', 'rendering', 'rendered', 'uploading'];
app.get('/api/exports', (req, res) => {
  const jobs = jobQueue
    .list({ status: 'completed', limit: 200 })
    .filter((j) => j.type === 'set-export');

  const byFile = {};
  for (const a of Object.values(loadApprovals())) {
    if (a && a.filePath) byFile[a.filePath] = a;
  }

  const schedEntries = scheduler.listEntries().filter((e) => SCHED_ACTIVE.includes(e.status));

  const exports = [];
  for (const j of jobs) {
    const r = j.progress && j.progress.phase === 'done' ? j.progress : null;
    if (!r || !r.outputUrl) continue;
    const a = r.outputPath ? byFile[r.outputPath] : null;
    const payload = j.payload || {};
    const name = payload.name || 'Export';
    // Match por jobId (entries creadas con exportJobId o renders del scheduler);
    // fallback por nombre para entries sin jobId todavía.
    const sched = schedEntries.find((e) => e.jobId === j.id)
      || schedEntries.find((e) => !e.jobId && e.name === name)
      || null;
    exports.push({
      jobId: j.id,
      name,
      setName: payload.name || null,
      type: payload.type || null,
      vertical: !!payload.vertical,
      setId: payload.setId || null,
      createdAt: j.createdAt,
      completedAt: j.completedAt,
      fileName: r.fileName,
      url: r.outputUrl,
      sizeBytes: r.sizeBytes || null,
      clipCount: r.clipCount || (Array.isArray(payload.items) ? payload.items.length : null),
      durationSec: r.durationSec || null,
      exists: r.outputPath ? fs.existsSync(r.outputPath) : false,
      title: (a && a.title) || null,
      approvalStatus: (a && a.status) || null, // pending | uploaded | discarded
      youtubeUrl: (a && a.youtubeUrl) || null,
      hasThumbnail: !!thumbnails.findThumbnail(j.id),
      scheduled: sched ? { id: sched.id, status: sched.status, publishAt: sched.publishAt } : null,
    });
  }
  exports.sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
  res.json({ exports });
});

// POST /api/exports/:jobId/thumbnail — guarda el thumbnail del export.
// Raw body con content-type image/jpeg o image/png (sin multer), máx 10 MB.
app.post(
  '/api/exports/:jobId/thumbnail',
  express.raw({ type: ['image/jpeg', 'image/png'], limit: '10mb' }),
  (req, res) => {
    const { jobId } = req.params;
    if (!thumbnails.isValidJobId(jobId)) {
      return res.status(400).json({ error: 'jobId inválido' });
    }
    const job = jobQueue.get(jobId);
    if (!job || job.type !== 'set-export') {
      return res.status(404).json({ error: `Export ${jobId} no encontrado` });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(415).json({ error: 'Enviá la imagen como body raw con Content-Type image/jpeg o image/png' });
    }
    if (req.body.length > thumbnails.MAX_BYTES) {
      return res.status(413).json({ error: 'Imagen muy grande (máx 10 MB)' });
    }
    const ext = req.headers['content-type'] === 'image/png' ? 'png' : 'jpg';
    try {
      thumbnails.saveThumbnail(jobId, req.body, ext);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    res.json({ ok: true, jobId, hasThumbnail: true, sizeBytes: req.body.length });
  }
);

// GET /api/exports/:jobId/thumbnail — sirve el thumbnail del export (404 si no tiene).
app.get('/api/exports/:jobId/thumbnail', (req, res) => {
  const thumb = thumbnails.findThumbnail(req.params.jobId);
  if (!thumb) return res.status(404).json({ error: 'El export no tiene thumbnail' });
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(thumb.path, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: err.message });
  });
});

function estimateRenderSeconds(totalStocks, options) {
  const paddingBefore = Number(options.paddingBefore || 7);
  const paddingAfter = Number(options.paddingAfter || 2);
  const avgClipDurationSeconds = paddingBefore + paddingAfter + 5; // ~5s del momento del kill
  const resolutionMultiplier = {
    '480p': 0.6,
    '1x': 0.5,
    '720p': 1.0,
    '1080p': 2.0,
    '2x': 1.2,
    'WQHD': 2.5,
    '4K': 4.0,
  }[options.resolution] || 1.0;
  const perStockSeconds = avgClipDurationSeconds * resolutionMultiplier;
  return Math.max(5, Math.round(totalStocks * perStockSeconds));
}

function countSelectedStocks(games) {
  return games.reduce((sum, g) => sum + (g.selectedStocks?.length || 0), 0);
}

// POST /api/process-stocks — procesa solo los stocks seleccionados
app.post('/api/process-stocks', (req, res) => {
  const { games, options = {} } = req.body;
  if (!Array.isArray(games) || games.length === 0) {
    return res.status(400).json({ error: 'Debes seleccionar al menos un juego' });
  }

  const filePaths = games.map((g) => g.filePath).filter(Boolean);
  const alreadyRunning = filePaths.find((p) => activeGames.has(p));
  if (alreadyRunning) {
    return res.status(409).json({ error: `Ya hay un render en curso para ${path.basename(alreadyRunning)}. Espera a que termine.` });
  }

  const totalStocks = countSelectedStocks(games);
  if (totalStocks === 0) {
    return res.status(400).json({ error: 'No hay stocks seleccionados para renderizar' });
  }

  const jobId = `job-${++jobCounter}`;
  const job = {
    id: jobId,
    status: 'queued',
    startedAt: new Date().toISOString(),
    completedAt: null,
    total: games.length,
    done: 0,
    errors: [],
    outputs: [],
    progress: null,
    estimatedSeconds: estimateRenderSeconds(totalStocks, options),
  };
  jobs.set(jobId, job);
  filePaths.forEach((p) => activeGames.add(p));

  notifyRenderStarted({ jobId, totalStocks, games, options }).catch(() => {});

  enqueueRender(job, async () => {
    const jobStartMs = Date.now();
    try {
      for (let i = 0; i < games.length; i++) {
        const game = games[i];
        try {
          const output = await processSelectedStocks(game, options, job);
          job.outputs.push(output);
        } catch (err) {
          job.errors.push({ file: game.filePath, error: err.message });
        }
        job.done = i + 1;
      }
      if (job.status === 'completed') {
        notifyRenderCompleted({
          jobId,
          total: job.total,
          done: job.done,
          errors: job.errors,
          outputs: job.outputs,
          elapsedSeconds: Math.round((Date.now() - jobStartMs) / 1000),
        }).catch(() => {});
      } else if (job.status === 'failed') {
        notifyRenderFailed({
          jobId,
          error: job.errors.map((e) => `${path.basename(e.file)}: ${e.error}`).join('; '),
        }).catch(() => {});
      }
    } catch (err) {
      job.status = 'failed';
      notifyRenderFailed({ jobId, error: err.message }).catch(() => {});
    } finally {
      filePaths.forEach((p) => activeGames.delete(p));
    }
  });

  res.json({
    jobId,
    message: `Procesando ${totalStocks} stock(s) de ${games.length} juego(s)`,
    status: 'queued',
    estimatedSeconds: job.estimatedSeconds,
  });
});

// archivos estáticos del dashboard en raíz y en /dashboard
app.use(express.static(DASHBOARD_DIR));
app.use('/dashboard', express.static(DASHBOARD_DIR));

// SPA fallback para rutas de React Router (excepto /api/*)
app.get(/^\/(?!api\/|clips-auto\/|compilations\/).*/, (req, res) => {
  res.sendFile(path.join(DASHBOARD_DIR, 'index.html'));
});

// clips .mp4 servidos también
app.use('/clips-auto', express.static(CLIPS_AUTO_DIR));
// compilaciones de sets (full-set / reels)
app.use('/compilations', express.static(COMPILATIONS_DIR));

function processGame(game, options) {
  return new Promise((resolve, reject) => {
    const args = [
      path.join(__dirname, 'process-single-game.js'),
      game.filePath,
    ];
    if (game.mainPlayer?.connectCode) args.push('--attacker', game.mainPlayer.connectCode);
    if (game.opponent?.connectCode) args.push('--victim', game.opponent.connectCode);
    if (options.paddingBefore) args.push('--padding-before', String(options.paddingBefore));
    if (options.paddingAfter) args.push('--padding-after', String(options.paddingAfter));
    if (options.sendTelegram) args.push('--telegram');
    if (options.copyToMac) args.push('--copy-to-mac');
    if (options.mixDiscord) args.push('--mix-discord');

    const child = spawn('node', args, {
      cwd: __dirname,
      env: {
        ...process.env,
        MIX_DISCORD_AUDIO: options.mixDiscord ? '1' : '0',
        DISCORD_AUDIO_OFFSET: String(options.discordAudioOffset || '0'),
        RENDER_RESOLUTION: options.resolution || '',
        RENDER_BITRATE: String(options.bitrate || ''),
        RENDER_WIDESCREEN: options.widescreen ? '1' : '0',
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `exit ${code}`));
      } else {
        resolve({ file: game.filePath, stdout, stderr });
      }
    });
  });
}

function renderStockGroup(game, group, outputDir, options, job = null, stockOffset = 0, totalStocks = 1) {
  return new Promise((resolve, reject) => {
    const isOpp = group.direction === 'opponent';
    const attackerIndex = isOpp ? game.opponent?.playerIndex : game.mainPlayer?.playerIndex;
    const victimIndex = isOpp ? game.mainPlayer?.playerIndex : game.opponent?.playerIndex;
    if (attackerIndex === undefined || victimIndex === undefined) {
      return reject(new Error('Faltan playerIndex para renderizar'));
    }

    const args = [
      path.join(__dirname, 'render-selected-stocks.js'),
      game.filePath,
      '--attacker-index', String(attackerIndex),
      '--victim-index', String(victimIndex),
      ...group.indices.map(String),
    ];

    const child = spawn('node', args, {
      cwd: __dirname,
      env: {
        ...process.env,
        CLIPS_OUTPUT_DIR: outputDir,
        PADDING_BEFORE: String(options.paddingBefore || '7'),
        PADDING_AFTER: String(options.paddingAfter || '2'),
        MIX_DISCORD_AUDIO: options.mixDiscord ? '1' : '0',
        DISCORD_AUDIO_OFFSET: String(options.discordAudioOffset || '0'),
        RENDER_RESOLUTION: options.resolution || '',
        RENDER_BITRATE: String(options.bitrate || ''),
        RENDER_WIDESCREEN: options.widescreen ? '1' : '0',
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      updateJobProgress(job, text, stockOffset, totalStocks);
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `exit ${code}`));
      } else {
        resolve({ outputDir, stdout, stderr });
      }
    });
  });
}

// Renderiza stocks en la Mac M3 via SSH en vez de usar Jarvis.
// Requiere que la Mac tenga mac-render.js, Dolphin, ISO y ffmpeg.
function renderStockGroupOnMac(game, group, outputDir, options, job = null, stockOffset = 0, totalStocks = 1) {
  return new Promise((resolve, reject) => {
    const isOpp = group.direction === 'opponent';
    const attackerIndex = isOpp ? game.opponent?.playerIndex : game.mainPlayer?.playerIndex;
    const victimIndex = isOpp ? game.mainPlayer?.playerIndex : game.opponent?.playerIndex;
    if (attackerIndex === undefined || victimIndex === undefined) {
      return reject(new Error('Faltan playerIndex para renderizar'));
    }

    const macHost = process.env.MAC_HOST || 'jay@100.69.130.90';
    const macKey = process.env.MAC_KEY || '/home/jay/.ssh/id_ed25519_kimi_mac';
    const macSlippiDir = process.env.MAC_SLIPPI_DIR || '/Users/jay/Slippi';
    const macOutputDir = process.env.MAC_CLIPS_DIR || '/Users/jay/Desktop/Slippi Clips/dashboard-mac';
    const macNodeBin = process.env.MAC_NODE_BIN || '/usr/local/bin/node';

    // Mapear ruta de Jarvis a Mac: /home/jay/slippi-live/2026-07/Game_...slp -> /Users/jay/Slippi/2026-07/Game_...slp
    const macSlpPath = game.filePath.replace(/^\/home\/jay\/slippi-live\//, `${macSlippiDir}/`);

    const indicesArg = group.indices.join(',');
    const envVars = [
      `PADDING_BEFORE='${options.paddingBefore || 7}'`,
      `PADDING_AFTER='${options.paddingAfter || 2}'`,
      `DISCORD_AUDIO_DELAY='${options.discordAudioOffset || 0}'`,
      `RENDER_BITRATE='${options.bitrate || 25000}'`,
      `RENDER_EFB_SCALE='${options.resolution === '480p' ? 2 : options.resolution === '720p' ? 3 : 4}'`,
    ];
    if (options.mixDiscord) envVars.push(`MIX_DISCORD_AUDIO='1'`);

    const cmd = `export ${envVars.join(' ')} && cd '${process.env.MAC_PIPELINE_DIR || '/Users/jay/slippi-pipeline'}' && '${macNodeBin}' mac-render.js '${macSlpPath}' --attacker-index ${attackerIndex} --victim-index ${victimIndex} --indices ${indicesArg} --output-dir '${macOutputDir}' --combine`;

    console.log('[mac-render] Ejecutando en Mac:', cmd);
    const child = spawn('ssh', [
      '-i', macKey,
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      macHost,
      cmd,
    ], { cwd: __dirname });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      updateJobProgress(job, text, stockOffset, totalStocks);
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || stdout || `mac-render salió con código ${code}`));
      }

      // Copiar clips resultantes de la Mac a Jarvis
      const baseName = path.basename(game.filePath, '.slp');
      const remoteClipsDir = `${macOutputDir}/${baseName}`;
      const localClipsDir = path.join(outputDir, baseName);
      fs.mkdirSync(localClipsDir, { recursive: true });

      const scpChild = spawn('scp', [
        '-i', macKey,
        '-o', 'BatchMode=yes',
        '-r',
        `${macHost}:${remoteClipsDir}/*`,
        `${localClipsDir}/`,
      ], { cwd: __dirname });

      scpChild.on('close', (scpCode) => {
        if (scpCode !== 0) {
          return reject(new Error(`scp de clips falló con código ${scpCode}`));
        }
        resolve({ outputDir: localClipsDir, stdout, stderr });
      });

      scpChild.on('error', (err) => reject(err));
    });

    child.on('error', (err) => reject(err));
  });
}

const PROGRESS_KEYWORDS = ['rendering frames:', 'rendering output file:', 'opening playback dolphin', 'frame=', 'size=', 'Press [q] to stop'];

function isProgressLine(line) {
  const l = line.toLowerCase();
  return PROGRESS_KEYWORDS.some((k) => l.includes(k.toLowerCase()));
}

function getProgressType(line) {
  const l = line.toLowerCase();
  if (l.includes('rendering frames:')) return 'frames';
  if (l.includes('rendering output file:')) return 'output';
  if (l.includes('opening playback dolphin')) return 'opening';
  if (l.includes('frame=') || l.includes('size=')) return 'ffmpeg';
  if (l.includes('press [q]')) return 'pressq';
  return 'other';
}

function extractCompleteLines(buffer) {
  const lastBreak = Math.max(buffer.lastIndexOf('\n'), buffer.lastIndexOf('\r'));
  if (lastBreak === -1) return { lines: [], remaining: buffer };
  const rawLines = buffer.slice(0, lastBreak).replace(/\r/g, '\n').split('\n');
  const lines = rawLines.map((l) => l.trim()).filter(Boolean);
  const remaining = buffer.slice(lastBreak + 1);
  return { lines, remaining };
}

function updateJobProgress(job, text, stockOffset, totalStocks) {
  if (!job || !job.progress) return;

  // Acumular chunk y extraer solo líneas completas (terminadas en \n o \r).
  job.progress._rawBuffer = (job.progress._rawBuffer || '') + text;
  const { lines, remaining } = extractCompleteLines(job.progress._rawBuffer);
  job.progress._rawBuffer = remaining;

  // Buscar líneas como: [render-selected] Stock 1: frame 1722 ...
  for (const line of lines) {
    const stockMatch = line.match(/\[render-selected\] Stock (\d+):/);
    if (stockMatch) {
      job.progress.currentStock = Math.min(stockOffset + parseInt(stockMatch[1], 10), totalStocks);
    }
  }

  // Buscar el último rendering frames: X% (N/M) en las líneas completas de este chunk.
  const frameMatches = lines
    .map((l) => l.match(/rendering frames:\s*(\d+\.?\d*)%\s*\((\d+)\/(\d+)\)/))
    .filter(Boolean);
  if (frameMatches.length > 0) {
    const last = frameMatches[frameMatches.length - 1];
    const stockProgress = parseFloat(last[1]);
    const currentStock = job.progress.currentStock || stockOffset + 1;
    const overallProgress = ((currentStock - 1) + stockProgress / 100) / totalStocks * 100;

    const now = Date.now();
    const elapsedMs = now - job.progress.startedAt;
    const etaSeconds = overallProgress > 1
      ? Math.round((elapsedMs / overallProgress) * (100 - overallProgress) / 1000)
      : null;

    job.progress = {
      ...job.progress,
      phase: 'rendering',
      currentStock: Math.min(currentStock, totalStocks),
      totalStocks,
      stockProgress,
      overallProgress,
      etaSeconds,
      lastUpdate: now,
    };
  }

  // Separar progreso de líneas de log.
  const progressLines = [];
  const normalLines = [];
  for (const line of lines) {
    if (isProgressLine(line)) {
      progressLines.push(line);
    } else if (line.length >= 3) {
      normalLines.push(line);
    }
  }

  // Mostrar solo la última línea de progreso de cada tipo.
  const lastProgressByType = {};
  for (const p of progressLines) {
    lastProgressByType[getProgressType(p)] = p;
  }
  const lastProgressLines = Object.values(lastProgressByType);
  if (lastProgressLines.length > 0) {
    job.progress.lastProgressLine = lastProgressLines.join(' | ');
  }

  // Añadir líneas no-progreso al log, evitando duplicados consecutivos.
  if (normalLines.length > 0) {
    const existing = job.progress.log || '';
    const newText = normalLines.join('\n') + '\n';
    if (!existing.endsWith(newText)) {
      job.progress.log = (existing + newText).slice(-2000);
    }
  }
}

function postProcessOutput(outputDir, label, options) {
  if (options.sendTelegram) {
    spawn('node', [path.join(__dirname, 'send-telegram.js'), outputDir], {
      cwd: __dirname,
      env: { ...process.env, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8988066588:AAGmnziOt1ATk9j8IseiAxHyyA50DCq-kgU', TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '6932565341' },
      stdio: 'inherit',
    });
  }
  if (options.copyToMac) {
    const macDest = `/Users/jay/Desktop/Slippi Clips/${path.basename(outputDir)}`;
    spawn('ssh', ['-i', process.env.MAC_KEY || '/home/jay/.ssh/id_ed25519_kimi_mac', process.env.MAC_HOST || 'jay@100.69.130.90', `mkdir -p '${macDest}'`]);
    spawn('scp', ['-i', process.env.MAC_KEY || '/home/jay/.ssh/id_ed25519_kimi_mac', `${outputDir}/*.mp4`, `${process.env.MAC_HOST || 'jay@100.69.130.90'}:'${macDest}/'`], { shell: true });
  }
}

function saveSelectedStocksToDashboard(game, outputDir) {
  try {
    const manifestPath = path.join(outputDir, 'selected-stocks-manifest.json');
    if (!fs.existsSync(manifestPath)) return;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const relativeOutputDir = path.basename(outputDir);
    const dashboardGame = {
      fileName: path.basename(game.filePath),
      filePath: game.filePath,
      label: relativeOutputDir,
      outputDir: relativeOutputDir,
      stage: manifest.stage,
      durationSeconds: manifest.durationSeconds,
      attacker: manifest.attacker,
      victim: manifest.victim,
      winner: manifest.winner,
      stockKills: manifest.stockKills,
      date: new Date().toISOString(),
      stocks: (manifest.clips || []).map((c, i) => ({
        index: i,
        path: `/clips-auto/${relativeOutputDir}/${c.file}`,
        direction: 'main',
      })),
      combinedPath: manifest.combined ? `/clips-auto/${relativeOutputDir}/${manifest.combined}` : undefined,
    };
    if (!fs.existsSync(DASHBOARD_GAMES_DIR)) fs.mkdirSync(DASHBOARD_GAMES_DIR, { recursive: true });
    const dashboardFile = path.join(DASHBOARD_GAMES_DIR, `${relativeOutputDir}-games.json`);
    fs.writeFileSync(dashboardFile, JSON.stringify({ generatedAt: new Date().toISOString(), games: [dashboardGame] }, null, 2));
  } catch (e) {
    console.warn('[process-stocks] No se pudo guardar en dashboard:', e.message);
  }
}

function processSelectedStocks(game, options, job = null) {
  return new Promise((resolve, reject) => {
    const label = path.basename(game.filePath, '.slp');
    const lead = Math.round(Number(options.paddingBefore || 7));
    const pad = Math.round(Number(options.paddingAfter || 2));
    // Incluir lead/pad en la carpeta para permitir re-exportar con otros settings.
    const baseOutputDir = path.join(CLIPS_AUTO_DIR, `${label}-selected-l${lead}p${pad}`);
    const rawSelected = game.selectedStocks || [];

    // Agrupar por dirección (main = HARD/JIMMY mata, opponent = le matan)
    const groups = {};
    for (const s of rawSelected) {
      const direction = s.direction || 'main';
      if (!groups[direction]) groups[direction] = { direction, indices: [] };
      groups[direction].indices.push(s.index);
    }

    const groupEntries = Object.values(groups);
    if (groupEntries.length === 0) {
      return reject(new Error('No hay stocks seleccionados'));
    }

    const totalStocks = groupEntries.reduce((sum, g) => sum + g.indices.length, 0);
    if (job) {
      job.progress = {
        phase: 'rendering',
        currentStock: 0,
        totalStocks,
        stockProgress: 0,
        overallProgress: 0,
        etaSeconds: null,
        startedAt: Date.now(),
        lastUpdate: Date.now(),
        log: '',
        lastProgressLine: '',
      };
    }

    const results = [];
    (async () => {
      try {
        let stockOffset = 0;
        const useMac = options.useMacRender || process.env.USE_MAC_RENDER === '1';
        for (const group of groupEntries) {
          const outputDir = group.direction === 'opponent'
            ? `${baseOutputDir}-opp`
            : baseOutputDir;
          const r = useMac
            ? await renderStockGroupOnMac(game, group, outputDir, options, job, stockOffset, totalStocks)
            : await renderStockGroup(game, group, outputDir, options, job, stockOffset, totalStocks);
          postProcessOutput(outputDir, label, options);
          saveSelectedStocksToDashboard(game, outputDir);
          results.push(r);
          stockOffset += group.indices.length;
        }
        resolve({ file: game.filePath, results });
      } catch (err) {
        reject(err);
      }
    })();
  });
}

ensureDirs();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dashboard-server] Escuchando en http://0.0.0.0:${PORT}`);
  console.log(`[dashboard-server] Replays: ${REPLAYS_DIR}`);
});
