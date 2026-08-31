// worker-server.js
// Proceso worker que consume jobs de la cola SQLite y ejecuta renders.
// Corre aparte del dashboard-server para no bloquear la API.

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const path = require('path');
const { spawn } = require('child_process');
const { JobQueue } = require('./queue');
const { notifyRenderStarted, notifyRenderCompleted, notifyRenderFailed } = require('./pipeline-notifications');
const { runSetExportJob, notifyFailed: notifySetFailed, CancelledError } = require('./set-export');
const { runPreviewJob } = require('./preview-render');
const { loadCachedGames } = require('./scan-replays');
const { getGameStocks } = require('./sets-stocks');
const scheduler = require('./scheduler');
const autoShorts = require('./auto-shorts');

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL || '2000');
const SCHEDULER_TICK_MS = Number(process.env.SCHEDULER_TICK_MS || '60000');
const CONCURRENT_JOBS = Number(process.env.WORKER_CONCURRENT || '1');

const queue = new JobQueue();
let running = 0;
let shouldStop = false;

function log(...args) {
  console.log(`[worker] ${new Date().toISOString()}`, ...args);
}

function runRenderJob(job) {
  return new Promise((resolve, reject) => {
    const { filePath, selectedStocks, options, mainPlayer, opponent } = job.payload;
    const outputDirBase = path.basename(filePath, '.slp');
    const lead = Math.round(Number(options.paddingBefore || 7));
    const pad = Math.round(Number(options.paddingAfter || 2));

    // Agrupar stocks por dirección igual que dashboard-server
    const groups = {};
    for (const s of selectedStocks || []) {
      const direction = s.direction || 'main';
      if (!groups[direction]) groups[direction] = { direction, indices: [] };
      groups[direction].indices.push(s.index);
    }
    const groupEntries = Object.values(groups);
    if (groupEntries.length === 0) {
      return reject(new Error('No hay stocks seleccionados'));
    }

    const totalStocks = groupEntries.reduce((sum, g) => sum + g.indices.length, 0);
    notifyRenderStarted({ jobId: job.id, totalStocks, games: [job.payload], options }).catch(() => {});

    const progress = {
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

    let stockOffset = 0;
    const results = [];

    (async () => {
      try {
        for (const group of groupEntries) {
          const isOpp = group.direction === 'opponent';
          const attackerIndex = isOpp ? opponent?.playerIndex : mainPlayer?.playerIndex;
          const victimIndex = isOpp ? mainPlayer?.playerIndex : opponent?.playerIndex;
          if (attackerIndex === undefined || victimIndex === undefined) {
            throw new Error('Faltan playerIndex para renderizar');
          }

          const outputDir = path.join(
            __dirname,
            'clips-auto',
            group.direction === 'opponent'
              ? `${outputDirBase}-selected-l${lead}p${pad}-opp`
              : `${outputDirBase}-selected-l${lead}p${pad}`
          );

          const args = [
            path.join(__dirname, 'render-selected-stocks.js'),
            filePath,
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
          child.stdout.on('data', (d) => {
            const text = d.toString();
            stdout += text;
            updateProgressFromText(progress, text, stockOffset, totalStocks);
            queue.updateProgress(job.id, progress);
          });

          let stderr = '';
          child.stderr.on('data', (d) => { stderr += d.toString(); });

          await new Promise((res, rej) => {
            child.on('close', (code) => {
              if (code !== 0) rej(new Error(stderr || stdout || `exit ${code}`));
              else res();
            });
          });

          results.push({ outputDir, stdout, stderr });
          stockOffset += group.indices.length;
        }

        notifyRenderCompleted({
          jobId: job.id,
          total: 1,
          done: 1,
          errors: [],
          outputs: results,
          elapsedSeconds: Math.round((Date.now() - progress.startedAt) / 1000),
        }).catch(() => {});

        resolve({ results });
      } catch (err) {
        notifyRenderFailed({ jobId: job.id, error: err.message }).catch(() => {});
        reject(err);
      }
    })();
  });
}

const PROGRESS_REGEX = /rendering (frames|output file):\s*(\d+\.?\d*)%\s*\(([^)]+)\)/i;
const STOCK_REGEX = /\[render-selected\] Stock (\d+):/;

// Job 'compute-stocks': recorre TODOS los juegos escaneados computando stocks
// con getGameStocks (cacheado por ruta+mtime: solo recomputa stale, así que es
// resumible). CPU-bound sin Dolphin; corre en la misma cola que los renders
// (CONCURRENT_JOBS=1), así que nunca compite con un set-export.
function runComputeStocksJob(job) {
  const cache = loadCachedGames();
  const games = cache?.games || [];
  const total = games.length;
  let current = 0;
  let failed = 0;
  log(`compute-stocks: ${total} juegos a revisar`);
  for (const g of games) {
    // Entre juego y juego se detecta una cancelación desde la API.
    const fresh = queue.get(job.id);
    if (fresh && fresh.status === 'cancelled') {
      const err = new Error('Job cancelado');
      err.cancelled = true;
      throw err;
    }
    try {
      getGameStocks(g.filePath);
    } catch (err) {
      failed++;
      log('compute-stocks: falló', g.filePath, '-', err.message);
    }
    current++;
    queue.updateProgress(job.id, { phase: 'scan', current, total, failed });
  }
  return { current, total, failed };
}

function updateProgressFromText(progress, text, stockOffset, totalStocks) {
  progress._rawBuffer = (progress._rawBuffer || '') + text;
  const lastBreak = Math.max(progress._rawBuffer.lastIndexOf('\n'), progress._rawBuffer.lastIndexOf('\r'));
  if (lastBreak === -1) return;
  const rawLines = progress._rawBuffer.slice(0, lastBreak).replace(/\r/g, '\n').split('\n');
  const lines = rawLines.map((l) => l.trim()).filter(Boolean);
  progress._rawBuffer = progress._rawBuffer.slice(lastBreak + 1);

  for (const line of lines) {
    const stockMatch = line.match(STOCK_REGEX);
    if (stockMatch) {
      progress.currentStock = Math.min(stockOffset + parseInt(stockMatch[1], 10), totalStocks);
    }
  }

  const frameMatches = lines
    .map((l) => l.match(PROGRESS_REGEX))
    .filter(Boolean);
  if (frameMatches.length > 0) {
    const last = frameMatches[frameMatches.length - 1];
    progress.stockProgress = parseFloat(last[2]);
    const currentStock = progress.currentStock || stockOffset + 1;
    progress.overallProgress = ((currentStock - 1) + progress.stockProgress / 100) / totalStocks * 100;

    const elapsedMs = Date.now() - progress.startedAt;
    progress.etaSeconds = progress.overallProgress > 1
      ? Math.round((elapsedMs / progress.overallProgress) * (100 - progress.overallProgress) / 1000)
      : null;
    progress.lastUpdate = Date.now();
  }

  const progressLines = lines.filter((l) => PROGRESS_REGEX.test(l));
  if (progressLines.length > 0) {
    progress.lastProgressLine = progressLines[progressLines.length - 1];
  }
}

// Si hay un worker remoto vivo (Mac), el worker local cede los tipos que el
// remoto maneja (set-export, preview) y solo toma jobs locales (compute-stocks,
// render-stock). Se consulta /api/worker/status con cache de 15s para no
// pegarle al API en cada tick de 2s.
const REMOTE_TYPES = ['set-export', 'preview'];
let remoteStatusCache = { at: 0, active: false };

async function isRemoteWorkerActive() {
  const now = Date.now();
  if (now - remoteStatusCache.at < 15_000) return remoteStatusCache.active;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://localhost:${process.env.DASHBOARD_PORT || 8081}/api/worker/status`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json();
    remoteStatusCache = { at: now, active: !!data.remoteActive };
  } catch {
    // API caída o lenta: asumir sin remoto (comportamiento normal).
    remoteStatusCache = { at: now, active: false };
  }
  return remoteStatusCache.active;
}

async function processNext() {
  if (shouldStop || running >= CONCURRENT_JOBS) return;
  let job;
  try {
    const excludeTypes = (await isRemoteWorkerActive()) ? REMOTE_TYPES : undefined;
    job = queue.claimNext({ excludeTypes });
  } catch (err) {
    // Lock transitorio de SQLite (u otro error de cola): NO tumbar el worker,
    // el próximo tick lo reintenta.
    log('claimNext falló, se reintenta en el próximo tick:', err.message);
    return;
  }
  if (!job) return;

  running++;
  log('Procesando job', job.id, job.type);

  try {
    if (job.type === 'render-stock') {
      const result = await runRenderJob(job);
      queue.complete(job.id, { progress: result });
    } else if (job.type === 'set-export') {
      const result = await runSetExportJob(job, queue);
      queue.complete(job.id, { progress: { phase: 'done', ...result } });
    } else if (job.type === 'preview') {
      const result = await runPreviewJob(job, queue);
      queue.complete(job.id, { progress: { phase: 'done', ...result } });
    } else if (job.type === 'compute-stocks') {
      const result = runComputeStocksJob(job);
      queue.complete(job.id, { progress: { phase: 'done', ...result } });
    } else {
      throw new Error(`Tipo de job no soportado: ${job.type}`);
    }
  } catch (err) {
    if (err instanceof CancelledError || err.cancelled) {
      // El job ya quedó en 'cancelled'; no re-encolar ni marcar como fallido.
      log('Job cancelado', job.id);
    } else {
      log('Job fallido', job.id, err.message);
      if (job.type === 'set-export') {
        notifySetFailed(job, err.message).catch(() => {});
      }
      queue.fail(job.id, err.message);
    }
  } finally {
    running--;
  }
}

function start() {
  log('Worker iniciado. Concurrente:', CONCURRENT_JOBS, 'poll:', POLL_INTERVAL_MS + 'ms');
  const timer = setInterval(() => {
    if (shouldStop && running === 0) {
      clearInterval(timer);
      process.exit(0);
    }
    processNext();
  }, POLL_INTERVAL_MS);

  // Scheduler de contenido: cada 60s encola renders programados y sube a
  // YouTube los que ya llegaron a publishAt. tick() ya tiene guard interno
  // anti-solape y try/catch total; el catch de aquí es cinturón y tirantes.
  const schedulerTimer = setInterval(() => {
    if (shouldStop) return;
    scheduler.tick(queue).catch((err) => log('Scheduler tick error:', err.message));
    autoShorts.tick(queue).catch((err) => log('Auto-shorts tick error:', err.message));
  }, SCHEDULER_TICK_MS);
  scheduler.tick(queue).catch((err) => log('Scheduler tick error:', err.message));
  autoShorts.tick(queue).catch((err) => log('Auto-shorts tick error:', err.message));

  process.on('SIGTERM', () => clearInterval(schedulerTimer));
  process.on('SIGINT', () => clearInterval(schedulerTimer));
}

process.on('SIGTERM', () => {
  log('SIGTERM recibido, esperando jobs activos...');
  shouldStop = true;
});

process.on('SIGINT', () => {
  log('SIGINT recibido, esperando jobs activos...');
  shouldStop = true;
});

start();
