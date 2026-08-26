// scheduler.js
// Scheduler de contenido: programa exports de sets (reel / full-set) para
// renderizarlos ANTES de una fecha de publicación y subirlos a YouTube
// (private) cuando llega publishAt. Persistencia en schedule.json con
// escritura atómica (tmp + rename).
//
// Flujo de una entry:
//   scheduled -> rendering -> rendered -> uploading -> uploaded
//                    \-> error                 \-> error
//
// El tick() corre en worker-server.js cada 60s. Los renders van a la cola
// SQLite (un render a la vez); los uploads se hacen directo con
// youtube-upload.js. YouTube publishAt NO se usa (app OAuth sin verificar
// solo permite private): el scheduler es quien controla cuándo subir.

const fs = require('fs');
const path = require('path');
const { getSet } = require('./sets-store');
const { uploadVideo } = require('./youtube-upload');
const approvals = require('./approvals');

const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');

// Estimaciones de render (calibradas con estimateJobSeconds del dashboard):
// reel ~150s por clip; full-set ~300s por juego. Margen extra fijo de 15min.
const REEL_SECONDS_PER_ITEM = 150;
const FULLSET_SECONDS_PER_GAME = 300;
const RENDER_MARGIN_SEC = 15 * 60;

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.SET_TELEGRAM_BOT_TOKEN || '8867205267:AAHcQE0j3Q-pYn2rbUdNRj9CkRFPvDyVodE';
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID || process.env.SET_TELEGRAM_CHAT_ID || '6932565341';

function log(...args) {
  console.log(`[scheduler] ${new Date().toISOString()}`, ...args);
}

// ── Persistencia ────────────────────────────────────────────────────────────

function loadEntries() {
  if (!fs.existsSync(SCHEDULE_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[scheduler] schedule.json corrupto, ignorando:', e.message);
    return [];
  }
}

function saveEntries(entries) {
  const tmp = `${SCHEDULE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, SCHEDULE_FILE);
}

// ── CRUD ────────────────────────────────────────────────────────────────────

function createEntry(data) {
  const entries = loadEntries();
  const entry = {
    id: `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    setId: data.setId,
    name: data.name,
    type: data.type,
    items: data.type === 'reel' ? (data.items || []) : null,
    targetDurationSec: data.targetDurationSec || null,
    vertical: !!data.vertical,
    leadSeconds: Math.max(0, Math.min(60, Number(data.leadSeconds) || 0)),
    // Pista de music/ para mezclar en el render (null = sin música).
    music: data.music && data.music.file ? { file: data.music.file, gameVolume: data.music.gameVolume ?? 0.2 } : null,
    title: data.title || '',
    description: data.description || '',
    tags: Array.isArray(data.tags) ? data.tags : [],
    publishAt: data.publishAt,
    // Overrides para programar la subida de un export YA renderizado
    // (POST /api/schedule con exportJobId): entra directo en 'rendered'.
    status: data.status || 'scheduled',
    jobId: data.jobId || null,
    outputPath: data.outputPath || null,
    youtubeUrl: data.youtubeUrl || null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  entries.push(entry);
  saveEntries(entries);
  return entry;
}

function listEntries() {
  return loadEntries().sort((a, b) => String(a.publishAt).localeCompare(String(b.publishAt)));
}

function getEntry(id) {
  return loadEntries().find((e) => e.id === id) || null;
}

function updateEntry(id, patch) {
  const entries = loadEntries();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  entries[idx] = { ...entries[idx], ...patch, id: entries[idx].id, createdAt: entries[idx].createdAt };
  saveEntries(entries);
  return entries[idx];
}

function deleteEntry(id) {
  const entries = loadEntries();
  const filtered = entries.filter((e) => e.id !== id);
  if (filtered.length === entries.length) return false;
  saveEntries(filtered);
  return true;
}

// ── Estimación de render ────────────────────────────────────────────────────

// Segundos estimados de render de una entry (sin margen).
function estimateRenderSec(entry) {
  if (entry.type === 'full-set') {
    const set = entry.setId ? getSet(entry.setId) : null;
    const gameCount = (set?.gamePaths || []).length || 1;
    return gameCount * FULLSET_SECONDS_PER_GAME;
  }
  const itemCount = (entry.items || []).length || 1;
  return itemCount * REEL_SECONDS_PER_ITEM;
}

// Cuándo hay que empezar a renderizar para llegar a publishAt (con margen).
function renderStartAt(entry) {
  return new Date(new Date(entry.publishAt).getTime() - (estimateRenderSec(entry) + RENDER_MARGIN_SEC) * 1000);
}

// ── Telegram (fetch directo, sin require del bot) ───────────────────────────

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendTelegram(text, replyMarkup) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram sendMessage ${res.status}: ${body.slice(0, 200)}`);
  }
}

// Mismo formato que el mensaje de subida del bot (telegram-compile-bot.js).
async function notifyPublished(entry) {
  const desc = String(entry.description || '').slice(0, 800);
  await sendTelegram(
    `✅ <b>Publicado (programado)</b>\n\n📌 <b>${escapeHtml(entry.title || '(sin título)')}</b>\n📺 ${entry.youtubeUrl}\n\n📝 ${escapeHtml(desc)}${String(entry.description || '').length > 800 ? '…' : ''}\n\n🏷️ ${escapeHtml((entry.tags || []).join(', '))}`,
    { inline_keyboard: [[{ text: '🔗 Ver en YouTube', url: entry.youtubeUrl }]] }
  );
}

async function notifyError(entry, error) {
  const msg = String(error).slice(0, 200);
  await sendTelegram(
    `❌ <b>Error en publicación programada</b>\n\n📌 <b>${escapeHtml(entry.title || entry.name)}</b>\n${escapeHtml(msg)}`
  );
}

// Avisa que empezó el upload con un ETA burdo (20 Mbps up como piso; el
// progreso real se ve con /status en el bot).
async function notifyUploading(entry) {
  const sizeBytes = entry.outputPath && fs.existsSync(entry.outputPath) ? fs.statSync(entry.outputPath).size : 0;
  const sizeMb = sizeBytes / (1024 * 1024);
  const etaMin = Math.max(1, Math.round(sizeMb / 2.5 / 60)); // ~20 Mbps
  await sendTelegram(
    `⏫ <b>Subiendo a YouTube</b>\n\n📌 <b>${escapeHtml(entry.title || entry.name)}</b>\n📦 ${sizeMb >= 1024 ? `${(sizeMb / 1024).toFixed(1)} GB` : `${Math.round(sizeMb)} MB`} — ETA ~${etaMin} min\n\nUsa /status para ver el progreso en vivo.`
  );
}

// ── Tick ────────────────────────────────────────────────────────────────────

// Items a renderizar: reel usa entry.items; full-set usa los gamePaths del set.
function resolveItems(entry) {
  if (entry.type === 'full-set') {
    const set = entry.setId ? getSet(entry.setId) : null;
    const gamePaths = set?.gamePaths || [];
    if (gamePaths.length === 0) throw new Error(`Set ${entry.setId} sin juegos`);
    return gamePaths.map((gamePath) => ({ gamePath }));
  }
  const items = (entry.items || []).filter((it) => it && it.gamePath);
  if (items.length === 0) throw new Error('Entry reel sin items');
  return items;
}

async function tickEntry(queue, entry, now) {
  // 1. Encolar el render cuando falta (renderEstimate + 15min) para publishAt.
  if (entry.status === 'scheduled' && !entry.jobId && now >= renderStartAt(entry).getTime()) {
    const items = resolveItems(entry);
    const jobId = queue.add('set-export', {
      setId: entry.setId,
      name: entry.name,
      type: entry.type,
      items,
      vertical: entry.vertical,
      leadSeconds: entry.leadSeconds,
      music: entry.music || null,
    });
    updateEntry(entry.id, { status: 'rendering', jobId, error: null });
    log(`Entry ${entry.id} (${entry.name}) encolada para render, job ${jobId}`);
    return;
  }

  // 2. Seguimiento del render.
  if (entry.status === 'rendering' && entry.jobId) {
    const job = queue.get(entry.jobId);
    if (!job) {
      updateEntry(entry.id, { status: 'error', error: `Job ${entry.jobId} no encontrado en la cola` });
      return;
    }
    if (job.status === 'completed') {
      const outputPath = job.progress?.outputPath || null;
      updateEntry(entry.id, { status: 'rendered', outputPath, error: null });
      log(`Entry ${entry.id} renderizada: ${outputPath}`);
    } else if (job.status === 'failed' || job.status === 'cancelled') {
      const error = job.error || `Job ${job.status}`;
      const updated = updateEntry(entry.id, { status: 'error', error });
      log(`Entry ${entry.id} falló en render: ${error}`);
      notifyError(updated || entry, error).catch((e) => log('Telegram notify error:', e.message));
    }
    return;
  }

  // 3. Upload a YouTube cuando llega publishAt.
  if (entry.status === 'rendered' && now >= new Date(entry.publishAt).getTime()) {
    const filePath = entry.outputPath;
    if (!filePath || !fs.existsSync(filePath)) {
      const error = `Archivo renderizado no disponible: ${filePath || '(desconocido)'}`;
      const updated = updateEntry(entry.id, { status: 'error', error });
      notifyError(updated || entry, error).catch((e) => log('Telegram notify error:', e.message));
      return;
    }
    updateEntry(entry.id, { status: 'uploading', error: null });
    log(`Entry ${entry.id} subiendo a YouTube: ${filePath}`);
    notifyUploading(entry).catch((e) => log('Telegram notify error:', e.message));
    try {
      const { url } = await uploadVideo({
        filePath,
        title: entry.title,
        description: entry.description,
        tags: entry.tags,
        isShort: entry.type === 'reel',
        privacy: 'private', // apps OAuth sin verificar de Google solo pueden subir private
        jobId: entry.jobId, // aplica thumbnails/<jobId>.<ext> si existe
      });
      const updated = updateEntry(entry.id, { status: 'uploaded', youtubeUrl: url });
      log(`Entry ${entry.id} publicada: ${url}`);
      // Si este export tenía un approval de Telegram pendiente/programado,
      // marcarlo como subido para que los botones no lo suban duplicado.
      try {
        const appr = approvals.findByFilePath(filePath);
        if (appr && appr.status !== 'uploaded') {
          approvals.updateApproval(appr.id, { status: 'uploaded', youtubeUrl: url });
        }
      } catch (e) {
        log('No se pudo sincronizar approval:', e.message);
      }
      notifyPublished(updated).catch((e) => log('Telegram notify error:', e.message));
    } catch (err) {
      const updated = updateEntry(entry.id, { status: 'error', error: err.message });
      log(`Entry ${entry.id} falló en upload:`, err.message);
      notifyError(updated || entry, err.message).catch((e) => log('Telegram notify error:', e.message));
    }
  }
}

// Un tick completo. `ticking` evita solapar ticks (un upload puede tardar
// más de 60s). Cualquier error se loguea y no tumba el worker.
let ticking = false;
async function tick(queue) {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const entry of listEntries()) {
      try {
        await tickEntry(queue, entry, now);
      } catch (err) {
        log(`Error en entry ${entry.id}:`, err.message);
        try {
          updateEntry(entry.id, { status: 'error', error: err.message });
        } catch (e) { /* ignore */ }
      }
    }
  } catch (err) {
    log('Error en tick:', err.message);
  } finally {
    ticking = false;
  }
}

module.exports = {
  SCHEDULE_FILE,
  REEL_SECONDS_PER_ITEM,
  FULLSET_SECONDS_PER_GAME,
  RENDER_MARGIN_SEC,
  createEntry,
  listEntries,
  getEntry,
  updateEntry,
  deleteEntry,
  estimateRenderSec,
  renderStartAt,
  tick,
};
