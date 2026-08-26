// dashboard-mac-server.js
// Backend Express para el dashboard de Slippi orientado a macOS.
// Escanea replays desde /Users/jay/Slippi, detecta stocks y dispara
// renderizado en Jarvis. Los clips se envian por Telegram desde Jarvis
// para no consumir ancho de banda de la conexion domestica de la Mac.

const path = require('path');
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, '.env.telegram') });
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { spawn } = require('child_process');

const { scanReplays } = require('./scan-replays');
const { detectStocks } = require('./detect-stocks');
const { startRecording, stopRecording, getRecordings } = require('./discord-recorder');
const { renderSelectedStocksOnJarvis } = require('./jarvis-render');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.DASHBOARD_MAC_PORT || 8082;
const REPLAYS_DIR = process.env.REPLAYS_DIR_MAC || '/Users/jay/Slippi';
const REPLAYS_DIR_FINAL = REPLAYS_DIR;
const DEFAULT_MAX_AGE_DAYS = Number(process.env.DASHBOARD_MAX_AGE_DAYS || '60');

const DASHBOARD_DIR = path.join(__dirname, 'dashboard-mac');
const AUDIO_DELAYS_DB = '/Users/jay/slippi-pipeline/dashboard-mac-audio-delays.json';
const GAMES_CACHE = path.join(DASHBOARD_DIR, 'games-cache.json');

const jobs = new Map();
let jobCounter = 0;

function ensureDirs() {
  if (!fs.existsSync(DASHBOARD_DIR)) fs.mkdirSync(DASHBOARD_DIR, { recursive: true });
  if (!fs.existsSync(path.dirname(AUDIO_DELAYS_DB))) fs.mkdirSync(path.dirname(AUDIO_DELAYS_DB), { recursive: true });
}

function loadAudioDelays() {
  if (!fs.existsSync(AUDIO_DELAYS_DB)) return {};
  try {
    return JSON.parse(fs.readFileSync(AUDIO_DELAYS_DB, 'utf-8'));
  } catch (e) {
    console.error('[audio-delays] Error cargando DB:', e.message);
    return {};
  }
}

function saveAudioDelay(slpPath, delay) {
  const db = loadAudioDelays();
  db[slpPath] = delay;
  fs.writeFileSync(AUDIO_DELAYS_DB, JSON.stringify(db, null, 2));
}

function getAudioDelay(slpPath) {
  const db = loadAudioDelays();
  return db[slpPath] || 0;
}

function loadCachedGames() {
  if (!fs.existsSync(GAMES_CACHE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(GAMES_CACHE, 'utf-8'));
    if (Array.isArray(data.games)) return data;
    return null;
  } catch (e) {
    return null;
  }
}

function saveCachedGames(games) {
  fs.writeFileSync(GAMES_CACHE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    count: games.length,
    games,
  }, null, 2));
}

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    replaysDir: REPLAYS_DIR_FINAL,
    audioDelaysDb: AUDIO_DELAYS_DB,
    renderBackend: 'jarvis',
  });
});

// GET /api/config — valores por defecto para Discord
app.get('/api/config', (req, res) => {
  res.json({
    replaysDir: REPLAYS_DIR_FINAL,
    discordGuildId: process.env.DISCORD_GUILD_ID || '',
    discordChannelId: process.env.DISCORD_CHANNEL_ID || '',
  });
});

// GET /api/games — devuelve juegos cacheados o escanea si no hay cache
app.get('/api/games', async (req, res) => {
  const cache = loadCachedGames();
  if (cache) return res.json({ cached: true, ...cache });

  try {
    const games = await scanReplays(REPLAYS_DIR_FINAL, {
      includeDuration: false,
      maxAgeDays: DEFAULT_MAX_AGE_DAYS,
      progressCallback: (done, total) => {
        if (done % 50 === 0 || done === total) {
          console.log(`[scan] ${done}/${total}`);
        }
      },
    });
    saveCachedGames(games);
    res.json({ cached: false, generatedAt: new Date().toISOString(), count: games.length, games });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/refresh — fuerza re-escaneo
app.post('/api/refresh', async (req, res) => {
  res.json({ message: 'Scan started', replaysDir: REPLAYS_DIR_FINAL });
  try {
    const start = Date.now();
    const maxAgeDays = req.query.all === '1' ? 0 : DEFAULT_MAX_AGE_DAYS;
    const games = await scanReplays(REPLAYS_DIR_FINAL, {
      includeDuration: false,
      maxAgeDays,
      progressCallback: (done, total) => {
        if (done % 50 === 0 || done === total) {
          console.log(`[scan] ${done}/${total}`);
        }
      },
    });
    saveCachedGames(games);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[scan] Cache guardado: ${games.length} juegos en ${elapsed}s`);
  } catch (err) {
    console.error('[scan] Error:', err);
  }
});

// GET /api/stocks — stocks en ambas direcciones para un replay
app.get('/api/stocks', (req, res) => {
  const slpPath = req.query.slp;
  const p0 = parseInt(req.query.p0, 10);
  const p1 = parseInt(req.query.p1, 10);
  if (!slpPath || isNaN(p0) || isNaN(p1)) {
    return res.status(400).json({ error: 'Faltan parametros: slp, p0, p1' });
  }
  try {
    const data = detectStocks(slpPath, p0, p1);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/audio-delay — delay de calibracion de audio para un juego
app.get('/api/audio-delay', (req, res) => {
  const slpPath = req.query.slp;
  if (!slpPath) return res.status(400).json({ error: 'Falta slp' });
  res.json({ slpPath, delaySeconds: getAudioDelay(slpPath) });
});

// POST /api/audio-delay — guarda delay de calibracion de audio
app.post('/api/audio-delay', (req, res) => {
  const { slpPath, delaySeconds } = req.body;
  if (!slpPath || typeof delaySeconds !== 'number') {
    return res.status(400).json({ error: 'Faltan slpPath o delaySeconds' });
  }
  saveAudioDelay(slpPath, delaySeconds);
  res.json({ slpPath, delaySeconds });
});

// POST /api/render — renderiza stocks seleccionados
// backend: 'mac' | 'jarvis' (default: 'jarvis' porque Mac headless no funciona)
app.post('/api/render', async (req, res) => {
  const {
    slpPath,
    attackerIndex,
    victimIndex,
    indices,
    mixDiscord,
    combine,
    backend = 'jarvis',
  } = req.body;

  if (!slpPath || typeof attackerIndex !== 'number' || typeof victimIndex !== 'number' || !Array.isArray(indices) || indices.length === 0) {
    return res.status(400).json({ error: 'Faltan parametros: slpPath, attackerIndex, victimIndex, indices' });
  }

  const delaySeconds = getAudioDelay(slpPath);
  const jobId = `${backend}-job-${++jobCounter}`;
  const job = {
    id: jobId,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    output: null,
  };
  jobs.set(jobId, job);

  const runRender = async () => {
    if (backend === 'jarvis') {
      return await renderSelectedStocksOnJarvis(slpPath, attackerIndex, victimIndex, indices, {
        mixDiscord,
        sendTelegram: true,
        discordDelaySeconds: delaySeconds,
        leadSeconds: Number(req.body.paddingBefore || process.env.PADDING_BEFORE || '7'),
        padAfterSeconds: Number(req.body.paddingAfter || process.env.PADDING_AFTER || '2'),
      });
    }

    // backend === 'mac'
    return new Promise((resolve, reject) => {
      const args = [
        path.join(__dirname, 'mac-render.js'),
        slpPath,
        '--attacker-index', String(attackerIndex),
        '--victim-index', String(victimIndex),
        '--indices', indices.join(','),
        '--output-dir', CLIPS_DIR,
      ];
      if (mixDiscord) {
        args.push('--mix-discord', '--discord-delay', String(delaySeconds));
      }
      if (combine) args.push('--combine');

      const child = spawn('node', args, {
        cwd: __dirname,
        env: {
          ...process.env,
          DISCORD_AUDIO_DELAY: String(delaySeconds),
          PADDING_BEFORE: String(req.body.paddingBefore || process.env.PADDING_BEFORE || '7'),
          PADDING_AFTER: String(req.body.paddingAfter || process.env.PADDING_AFTER || '2'),
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
          try {
            const lines = stdout.split('\n').filter(Boolean);
            const lastLine = lines[lines.length - 1];
            resolve(JSON.parse(lastLine));
          } catch (e) {
            resolve({ stdout, stderr });
          }
        }
      });
    });
  };

  (async () => {
    try {
      const output = await runRender();
      job.status = 'completed';
      job.output = output;
      job.completedAt = new Date().toISOString();
      console.log(`[render job ${jobId}] completado`);
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      job.completedAt = new Date().toISOString();
      console.error(`[render job ${jobId}] fallo:`, err.message);
    }
  })();

  res.json({ jobId, status: 'running', backend, message: `Renderizando ${indices.length} stock(s) en ${backend}` });
});

// GET /api/jobs/:id
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

// GET /api/clips — clips enviados recientemente (desde jobs completados)
app.get('/api/clips', (req, res) => {
  const completed = Array.from(jobs.values())
    .filter((j) => j.status === 'completed' && j.output)
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
    .slice(0, 20)
    .map((j) => ({
      jobId: j.id,
      completedAt: j.completedAt,
      files: j.output.clips ? j.output.clips.map((c) => c.fileName) : [],
      combined: j.output.combined ? path.basename(j.output.combined) : null,
      telegramSent: !!j.output.telegramOutput,
    }));
  res.json({ clips: completed });
});

// Discord recording endpoints
app.post('/api/discord/start', async (req, res) => {
  const { guildId, channelId, userId } = req.body;
  if (!guildId || !channelId) {
    return res.status(400).json({ error: 'Faltan guildId o channelId' });
  }
  try {
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

app.get('/api/discord/recordings', (req, res) => {
  res.json({ recordings: getRecordings() });
});

// Archivos estaticos
app.use(express.static(DASHBOARD_DIR));

ensureDirs();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dashboard-mac-server] Escuchando en http://0.0.0.0:${PORT}`);
  console.log(`[dashboard-mac-server] Replays: ${REPLAYS_DIR_FINAL}`);
  console.log(`[dashboard-mac-server] Render backend: Jarvis + Telegram`);
});
