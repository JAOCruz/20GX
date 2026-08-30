// telegram-compile-bot.js
// Bot de Telegram que permite armar compilaciones de clips de Slippi.
//
// Cada clip enviado por send-telegram.js lleva un botón inline
// "Añadir a compilado". El usuario pulsa los clips que quiere incluir,
// luego envía /compile [nombre] y el bot concatena todo en un solo mp4.
// Además cada clip/set-export lleva botones "⬆️ Short" / "⬆️ Video" que
// suben el archivo a YouTube (privado) vía youtube-upload.js.
//
// Comandos:
//   /list      - ver clips seleccionados
//   /clear     - vaciar selección
//   /compile [nombre] - crear compilado y enviarlo
//
// Uso:
//   TELEGRAM_BOT_TOKEN=... node telegram-compile-bot.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { uploadVideo } = require('./youtube-upload');
const approvals = require('./approvals');
const { createEntry: createScheduleEntry } = require('./scheduler');
const { buildApprovalCaption } = require('./youtube-metadata');
const thumbnails = require('./thumbnails');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Chats autorizados a usar el bot (lista blanca). Sin esto, cualquiera que
// encuentre el bot puede mandarle comandos. TELEGRAM_CHAT_ID del .env.
const ALLOWED_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
function isAllowedChat(chatId) {
  if (chatId == null) return false;
  if (ALLOWED_CHAT_IDS.length === 0) return true; // sin config no bloqueamos
  return ALLOWED_CHAT_IDS.includes(String(chatId));
}
const INDEX_FILE = process.env.TELEGRAM_CLIP_INDEX || path.join(__dirname, 'telegram-clip-index.json');
const QUEUE_FILE = process.env.TELEGRAM_COMPILE_QUEUE || path.join(__dirname, 'telegram-compile-queue.json');
const OUTPUT_DIR = process.env.COMPILE_OUTPUT_DIR || path.join(__dirname, 'compilations');
const VOICEOVER_DIR = process.env.VOICEOVER_OUTPUT_DIR || path.join(__dirname, 'voiceovers');
const JOBS_DB = process.env.QUEUE_DB_PATH || path.join(__dirname, 'jobs.sqlite');

if (!BOT_TOKEN) {
  console.error('Falta TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

// Los clips del pipeline los envía otro bot (default en dashboard-server.js /
// process-single-game.js) y los set-exports éste (set-export.js). Los
// callback_query solo llegan al bot que envió el mensaje, así que se hace
// polling de ambos tokens y cada handler usa el token del update recibido.
const CLIPS_BOT_TOKEN = process.env.CLIPS_TELEGRAM_BOT_TOKEN || '8988066588:AAGmnziOt1ATk9j8IseiAxHyyA50DCq-kgU';
const BOT_TOKENS = [...new Set([BOT_TOKEN, CLIPS_BOT_TOKEN])];

// Mensajes ya procesados (cada update llega por el polling de cada bot).
const seenMessages = new Set();
// Subidas a YouTube: guard anti doble-click + cola secuencial en memoria.
const ytInFlight = new Set();
let ytUploadChain = Promise.resolve();

// Ediciones de metadata pendientes: chatId -> { approvalId, field, messageId, isText }.
// Cuando el usuario pulsa ✏️/📝, el próximo mensaje de texto plano de ese chat
// actualiza el campo en approvals.json.
const pendingEdits = {};

// Programaciones pendientes: chatId -> { approvalId }. Cuando el usuario pulsa
// 📅 Programar, el próximo mensaje de texto del chat se parsea como fecha/hora
// RD (UTC-4, sin DST) y crea una entry en schedule.json.
const pendingSchedules = {};
const RD_TZ_OFFSET_H = 4;

function apiUrl(token) {
  return `https://api.telegram.org/bot${token}`;
}

function loadJson(filePath, defaultValue = {}) {
  if (!fs.existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    return defaultValue;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadIndex() {
  return loadJson(INDEX_FILE, {});
}

function saveIndex(index) {
  saveJson(INDEX_FILE, index);
}

function loadQueue() {
  return loadJson(QUEUE_FILE, { selections: {} });
}

function saveQueue(queue) {
  saveJson(QUEUE_FILE, queue);
}

function getSelection(queue, chatId) {
  const key = String(chatId);
  if (!queue.selections[key]) queue.selections[key] = [];
  return queue.selections[key];
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendMessage(token, chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(`${apiUrl(token)}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) console.error('[bot] sendMessage error:', data);
  return data;
}

async function answerCallbackQuery(token, callbackQueryId, text) {
  await fetch(`${apiUrl(token)}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

async function editMessageCaption(token, chatId, messageId, caption, replyMarkup) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: 'HTML',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`${apiUrl(token)}/editMessageCaption`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function editMessageText(token, chatId, messageId, text, replyMarkup) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`${apiUrl(token)}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function sendVideo(token, chatId, videoPath, caption) {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('supports_streaming', 'true');
  form.append(
    'video',
    new Blob([fs.readFileSync(videoPath)], { type: 'video/mp4' }),
    path.basename(videoPath)
  );

  const res = await fetch(`${apiUrl(token)}/sendVideo`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram error: ${data.error_code} ${data.description}`);
  }
  return data;
}

function compileVideos(files, outputFile) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const listFile = path.join(OUTPUT_DIR, `compile-list-${Date.now()}.txt`);
  fs.writeFileSync(
    listFile,
    files.map((f) => `file '${path.resolve(f)}'`).join('\n')
  );

  execFileSync('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    outputFile,
  ], { stdio: 'inherit' });

  try { fs.unlinkSync(listFile); } catch (e) {}
  return outputFile;
}

// Teclado estándar de un clip/set-export: toggle de compilado + botones de
// YouTube (o link directo si ya se subió, o estado "subiendo").
function clipKeyboard(messageId, opts = {}) {
  const rows = [
    [{
      text: opts.inCompile ? '✅ En compilado (pulsa para quitar)' : '➕ Añadir a compilado',
      callback_data: `toggle_compile:${messageId}`,
    }],
  ];
  if (opts.youtubeUrl) {
    rows.push([{ text: '🔗 Ver en YouTube', url: opts.youtubeUrl }]);
  } else if (opts.uploading) {
    rows.push([{ text: '⏳ Subiendo a YouTube…', callback_data: `yt_busy:${messageId}` }]);
  } else {
    rows.push([
      { text: '⬆️ Short', callback_data: `yt_short:${messageId}` },
      { text: '⬆️ Video', callback_data: `yt_video:${messageId}` },
    ]);
  }
  return { inline_keyboard: rows };
}

async function handleToggleCompile(token, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const index = loadIndex();
  const entry = index[String(messageId)];

  if (!entry) {
    await answerCallbackQuery(token, callbackQuery.id, '❌ Clip no encontrado en el índice');
    return;
  }

  const editMessage = entry.isText ? editMessageText : editMessageCaption;
  const queue = loadQueue();
  const selection = getSelection(queue, chatId);
  const idx = selection.findIndex((s) => s.messageId === messageId);

  if (idx >= 0) {
    // Quitar del compilado
    selection.splice(idx, 1);
    saveQueue(queue);
    await answerCallbackQuery(token, callbackQuery.id, '❌ Quitado del compilado');
    await editMessage(
      token,
      chatId,
      messageId,
      entry.caption,
      clipKeyboard(messageId, { youtubeUrl: entry.youtubeUrl })
    );
  } else {
    // Añadir al compilado
    selection.push({
      messageId,
      filePath: entry.filePath,
      fileName: entry.fileName,
      caption: entry.caption,
      addedAt: new Date().toISOString(),
    });
    saveQueue(queue);
    await answerCallbackQuery(token, callbackQuery.id, '✅ Añadido al compilado');
    await editMessage(
      token,
      chatId,
      messageId,
      `${entry.caption}\n\n✅ <b>Añadido al compilado</b> (${selection.length})`,
      clipKeyboard(messageId, { inCompile: true, youtubeUrl: entry.youtubeUrl })
    );
  }
}

async function handleList(token, chatId) {
  const queue = loadQueue();
  const selection = getSelection(queue, chatId);
  if (selection.length === 0) {
    await sendMessage(token, chatId, '📭 No tienes clips seleccionados. Pulsa "Añadir a compilado" en los clips que quieras.');
    return;
  }
  const lines = selection.map((s, i) => `${i + 1}. ${s.fileName}`).join('\n');
  await sendMessage(token, chatId, `🎬 *Clips seleccionados (${selection.length}):*\n\n${lines}\n\nEnvía /compile [nombre] para unirlos.`);
}

async function handleClear(token, chatId) {
  const queue = loadQueue();
  queue.selections[String(chatId)] = [];
  saveQueue(queue);
  await sendMessage(token, chatId, '🗑️ Selección vaciada.');
}

function findManifestForClip(filePath) {
  const folder = path.dirname(filePath);
  const base = path.basename(filePath, '.mp4').replace(/_stock\d+$/, '').replace(/_all-stocks$/, '');
  const manifestPath = path.join(folder, `${base}-manifest.json`);
  if (fs.existsSync(manifestPath)) {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (e) {
      return null;
    }
  }
  const legacyPath = path.join(folder, 'stock-clips-manifest.json');
  if (fs.existsSync(legacyPath)) {
    try {
      return JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
    } catch (e) {
      return null;
    }
  }
  return null;
}

function getClipDetails(filePath) {
  const manifest = findManifestForClip(filePath);
  const fileName = path.basename(filePath);
  const clipManifest = manifest?.clips?.find((c) => c.file === fileName);
  return {
    manifest,
    clip: clipManifest,
  };
}

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function buildCompilationCaption(name, selection, outputFile) {
  const sizeMb = (fs.statSync(outputFile).size / 1024 / 1024).toFixed(1);

  // Agrupar por match (manifest)
  const matches = new Map();
  for (const s of selection) {
    const { manifest, clip } = getClipDetails(s.filePath);
    if (!manifest || !clip) continue;
    const key = manifest.slpPath;
    if (!matches.has(key)) {
      matches.set(key, {
        manifest,
        clips: [],
      });
    }
    matches.get(key).clips.push(clip);
  }

  const matchSummaries = [];
  for (const [, { manifest, clips }] of matches) {
    const a = escapeHtml(manifest.attacker.name);
    const aChar = escapeHtml(manifest.attacker.charName);
    const v = escapeHtml(manifest.victim.name);
    const vChar = escapeHtml(manifest.victim.charName);
    const stage = escapeHtml(manifest.stage);
    const winner = escapeHtml(manifest.winner);
    const lines = clips.map((c) => {
      const time = formatTime(c.stockTimeSeconds);
      const move = c.killMoveName ? escapeHtml(c.killMoveName) : '?';
      const pct = c.killPercent != null ? `${c.killPercent.toFixed(0)}%` : '?';
      const hits = c.comboHits != null ? `${c.comboHits} hits` : '';
      return `  💥 Stock @ ${time} — ${move} @ ${pct}${hits ? ` (${hits})` : ''}`;
    }).join('\n');
    matchSummaries.push(
      `🥊 <b>${a}</b> (${aChar}) vs <b>${v}</b> (${vChar})\n` +
      `🏟️ ${stage} · ⏱️ ${formatTime(manifest.durationSeconds)} · 🏆 ${winner}\n` +
      `${lines}`
    );
  }

  return (
    `🎬 <b>${escapeHtml(name)}</b>\n` +
    `${selection.length} clips · ${sizeMb} MB\n\n` +
    matchSummaries.join('\n\n')
  );
}

async function handleCompile(token, chatId, argsText) {
  const queue = loadQueue();
  const selection = getSelection(queue, chatId);

  if (selection.length === 0) {
    await sendMessage(token, chatId, '❌ No hay clips seleccionados. Pulsa "Añadir a compilado" primero.');
    return;
  }

  const name = argsText.trim() || `compilation-${Date.now()}`;
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const outputFile = path.join(OUTPUT_DIR, `${safeName}.mp4`);

  await sendMessage(token, chatId, `⏳ Compilando ${selection.length} clip(s) en *${name}*...`);

  try {
    const files = selection.map((s) => s.filePath);
    compileVideos(files, outputFile);

    const caption = buildCompilationCaption(name, selection, outputFile);
    await sendVideo(token, chatId, outputFile, caption);

    // Restaurar botones y captions de los clips usados
    const index = loadIndex();
    for (const s of selection) {
      const entry = index[String(s.messageId)];
      if (entry) {
        const editMessage = entry.isText ? editMessageText : editMessageCaption;
        await editMessage(
          token,
          chatId,
          s.messageId,
          entry.caption,
          clipKeyboard(s.messageId, { youtubeUrl: entry.youtubeUrl })
        );
      }
    }

    // Vaciar selección después de compilar
    queue.selections[String(chatId)] = [];
    saveQueue(queue);
  } catch (err) {
    console.error('[bot] Error compilando:', err);
    await sendMessage(token, chatId, `❌ Error al compilar: ${err.message}`);
  }
}

async function handleHelp(token, chatId) {
  await sendMessage(token, chatId,
    '🎬 <b>Bot de compilación de clips</b>\n\n' +
    'Cada clip que envío tiene un botón <b>"Añadir a compilado"</b> y botones ' +
    '<b>⬆️ Short</b> / <b>⬆️ Video</b> para subirlo a YouTube (privado).\n\n' +
    '<b>Comandos:</b>\n' +
    '/list - ver clips seleccionados\n' +
    '/clear - vaciar selección\n' +
    '/compile [nombre] - unir clips en un solo video\n' +
    '/status - qué está subiendo/renderizando/programado ahora\n' +
    '/help - mostrar esta ayuda\n\n' +
    '<b>Voice over:</b> responde a cualquier clip con un voice note y te devuelvo el clip con tu audio mezclado encima.\n\n' +
    '<b>Thumbnail:</b> responde a un clip/export (o a su aprobación) con una <b>foto</b> y la guardo como thumbnail de YouTube de ese export.'
  );
}

// /status: panorama en vivo — upload de YouTube en curso (upload-status.json,
// lo escribe youtube-upload.js), render activo (jobs.sqlite, read-only) y
// próximas publicaciones programadas (schedule.json).
async function handleStatus(token, chatId) {
  const lines = ['📊 <b>Status del pipeline</b>'];

  // 1. Upload de YouTube en curso
  const upPath = path.join(__dirname, 'upload-status.json');
  if (fs.existsSync(upPath)) {
    try {
      const up = JSON.parse(fs.readFileSync(upPath, 'utf-8'));
      // Si el archivo tiene >3 min sin actualizarse, el upload ya no está vivo.
      if (Date.now() - new Date(up.updatedAt).getTime() < 3 * 60 * 1000) {
        const pct = ((up.bytesSent / up.totalBytes) * 100).toFixed(1);
        const mbSent = Math.round(up.bytesSent / 1048576);
        const mbTotal = Math.round(up.totalBytes / 1048576);
        const mbps = (up.bytesPerSec / 1048576).toFixed(1);
        const etaMin = Math.floor(up.etaSec / 60);
        const etaS = Math.round(up.etaSec % 60);
        lines.push(
          '',
          `⏫ <b>Subiendo:</b> ${escapeHtml(path.basename(up.filePath))}`,
          `   ${pct}% (${mbSent}/${mbTotal} MB) a ${mbps} MB/s — quedan ~${etaMin}:${String(etaS).padStart(2, '0')} min`
        );
      }
    } catch (_) { /* best effort */ }
  }

  // 2. Render activo (misma lectura read-only que findExportJobId)
  if (fs.existsSync(JOBS_DB)) {
    let db;
    try {
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(JOBS_DB, { readOnly: true });
      const running = db.prepare("SELECT type, progress FROM jobs WHERE status = 'running' LIMIT 1").get();
      const pendingCount = db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE status = 'pending'").get().c;
      if (running) {
        const p = running.progress ? JSON.parse(running.progress) : null;
        const detail = p && p.total
          ? `${p.phase || ''} ${p.current}/${p.total}${p.etaSec ? ` — ETA ~${Math.max(1, Math.round(p.etaSec / 60))} min` : ''}`
          : 'en curso';
        lines.push('', `🎬 <b>Render (${running.type}):</b> ${detail}`);
      }
      if (pendingCount > 0) lines.push(`   ${pendingCount} job(s) esperando en cola`);
    } catch (_) { /* best effort */ } finally {
      if (db) db.close();
    }
  }

  // 3. Publicaciones programadas pendientes
  const schedPath = path.join(__dirname, 'schedule.json');
  if (fs.existsSync(schedPath)) {
    try {
      const entries = JSON.parse(fs.readFileSync(schedPath, 'utf-8'))
        .filter((e) => ['scheduled', 'rendering', 'rendered', 'uploading'].includes(e.status))
        .sort((a, b) => new Date(a.publishAt) - new Date(b.publishAt));
      for (const e of entries.slice(0, 5)) {
        const rd = new Date(new Date(e.publishAt).getTime() - RD_TZ_OFFSET_H * 3600 * 1000);
        const when = rd.toISOString().slice(0, 16).replace('T', ' ');
        lines.push('', `📅 <b>${escapeHtml(e.name || e.title)}</b>`, `   ${when} (RD) — ${e.status}`);
      }
    } catch (_) { /* best effort */ }
  }

  if (lines.length === 1) lines.push('', 'Todo quieto: nada subiendo, renderizando ni programado. ✅');
  await sendMessage(token, chatId, lines.join('\n'));
}

async function downloadTelegramFile(token, fileId, destPath) {
  const res = await fetch(`${apiUrl(token)}/getFile?file_id=${fileId}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`getFile error: ${data.description}`);
  const fileUrl = `https://api.telegram.org/file/bot${token}/${data.result.file_path}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) throw new Error(`download error: ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

// Resuelve el jobId de un set-export completado a partir de su archivo de
// salida (los mensajes del índice y los approvals no guardan jobId).
// Lee jobs.sqlite en modo solo-lectura para no interferir con el worker.
function findExportJobId(filePath) {
  if (!filePath || !fs.existsSync(JOBS_DB)) return null;
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(JOBS_DB, { readOnly: true });
    const rows = db
      .prepare("SELECT id, progress FROM jobs WHERE type = 'set-export' AND status = 'completed' ORDER BY createdAt DESC")
      .all();
    for (const row of rows) {
      try {
        const progress = JSON.parse(row.progress || 'null');
        if (progress && progress.outputPath === filePath) return row.id;
      } catch (e) { /* progress corrupto */ }
    }
  } catch (e) {
    console.error('[bot] findExportJobId error:', e.message);
  } finally {
    try { db && db.close(); } catch (e) {}
  }
  return null;
}

// Foto como respuesta a un clip/export -> thumbnail de YouTube del export.
// Se guarda en thumbnails/<jobId>.jpg y youtube-upload.js lo aplica al subir.
async function handleThumbnailPhoto(token, msg) {
  const chatId = msg.chat.id;
  const replyId = msg.reply_to_message.message_id;

  // Resolver el export: primero el índice de clips, si no los approvals.
  const entry = loadIndex()[String(replyId)];
  const approval = entry ? null : approvals.findByMessageId(replyId);
  const filePath = (entry && entry.filePath) || (approval && approval.filePath) || null;
  const label = (entry && entry.fileName) || (filePath && path.basename(filePath)) || null;

  if (!filePath) {
    await sendMessage(token, chatId, '❌ La foto debe ser <b>respuesta</b> a un mensaje de clip/export mío (o a su aprobación).');
    return;
  }
  const jobId = findExportJobId(filePath);
  if (!jobId) {
    await sendMessage(token, chatId, `❌ No pude identificar el job de <b>${escapeHtml(label || filePath)}</b> en la cola (¿muy viejo?).`);
    return;
  }

  // msg.photo viene de menor a mayor; la última es la de más resolución.
  const photo = msg.photo[msg.photo.length - 1];
  if (photo.file_size && photo.file_size > thumbnails.MAX_BYTES) {
    await sendMessage(token, chatId, '❌ La imagen pasa de 10 MB, mandala más chica.');
    return;
  }

  const tmpPath = path.join(thumbnails.THUMBNAILS_DIR, `tmp-${jobId}-${Date.now()}`);
  try {
    fs.mkdirSync(thumbnails.THUMBNAILS_DIR, { recursive: true });
    await downloadTelegramFile(token, photo.file_id, tmpPath);
    const buffer = fs.readFileSync(tmpPath);
    // Las fotos de Telegram siempre llegan como JPEG.
    thumbnails.saveThumbnail(jobId, buffer, 'jpg');

    // Si el video YA está subido (approval o entry del calendario con URL),
    // aplicar el thumbnail de una vez en vez de esperar un próximo upload.
    const thumbPath = thumbnails.findThumbnail(jobId)?.path;
    const uploadedUrl =
      (approval && approval.youtubeUrl) ||
      (() => {
        try {
          const entries = JSON.parse(fs.readFileSync(path.join(__dirname, 'schedule.json'), 'utf-8'));
          const match = entries.find((e) => e.jobId === jobId && e.youtubeUrl);
          return match && match.youtubeUrl;
        } catch (_) { return null; }
      })();
    if (uploadedUrl && thumbPath) {
      try {
        await require('./youtube-upload').applyThumbnailByUrl(uploadedUrl, thumbPath, 'image/jpeg');
        await sendMessage(
          token,
          chatId,
          `🖼️ <b>Thumbnail aplicado</b> en YouTube para <b>${escapeHtml(label || jobId)}</b> ✅\n📺 ${uploadedUrl}`
        );
        return;
      } catch (e) {
        await sendMessage(token, chatId, `⚠️ Thumbnail guardado pero no pude aplicarlo al video ya subido: ${escapeHtml(String(e.message || e)).slice(0, 200)}`);
        return;
      }
    }

    await sendMessage(
      token,
      chatId,
      `🖼️ <b>Thumbnail guardado</b> para <b>${escapeHtml(label || jobId)}</b>.\nSe aplicará automáticamente al subir el video a YouTube.`
    );
  } catch (err) {
    console.error('[bot] Error guardando thumbnail:', err);
    await sendMessage(token, chatId, `❌ Error guardando thumbnail: ${escapeHtml(String(err.message || err)).slice(0, 200)}`);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (e) {}
  }
}

function mixVoiceOver(videoPath, voicePath, outputPath) {
  execFileSync('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-i', voicePath,
    '-filter_complex', '[0:a:0]volume=0.6[a0];[1:a:0]volume=1.2[a1];[a0][a1]amix=inputs=2:duration=longest[out]',
    '-map', '0:v:0',
    '-map', '[out]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    outputPath,
  ], { stdio: 'inherit' });
  return outputPath;
}

async function handleVoiceNote(token, chatId, voiceMsg, replyToMessageId) {
  const index = loadIndex();
  const entry = index[String(replyToMessageId)];

  if (!entry) {
    await sendMessage(token, chatId, '❌ El voice note debe ser respuesta a un clip mío.');
    return;
  }

  await sendMessage(token, chatId, '⏳ Descargando y mezclando tu voice note...');

  try {
    if (!fs.existsSync(VOICEOVER_DIR)) fs.mkdirSync(VOICEOVER_DIR, { recursive: true });

    const baseName = path.basename(entry.filePath, '.mp4');
    const voiceOgg = path.join(VOICEOVER_DIR, `${baseName}_voice.ogg`);
    const voiceWav = path.join(VOICEOVER_DIR, `${baseName}_voice.wav`);
    const outputFile = path.join(VOICEOVER_DIR, `${baseName}_voiceover.mp4`);

    await downloadTelegramFile(token, voiceMsg.file_id, voiceOgg);

    // Convertir ogg a wav estereo 48kHz para mezclar
    execFileSync('ffmpeg', [
      '-y', '-i', voiceOgg,
      '-ar', '48000', '-ac', '2',
      voiceWav,
    ], { stdio: 'inherit' });

    mixVoiceOver(entry.filePath, voiceWav, outputFile);

    // Limpiar temporales
    try { fs.unlinkSync(voiceOgg); } catch (e) {}
    try { fs.unlinkSync(voiceWav); } catch (e) {}

    const caption = `🎙️ <b>Voice over</b>\n${entry.caption}`;
    await sendVideo(token, chatId, outputFile, caption);
  } catch (err) {
    console.error('[bot] Error voice over:', err);
    await sendMessage(token, chatId, `❌ Error al mezclar voice over: ${err.message}`);
  }
}

function stripHtml(html) {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Título de YouTube (<= 90 chars): los set-exports tipo reel se nombran
// "<Set> — Highlights Pt.N" (N = reels ya subidos de ese set + 1);
// full-sets usan nombre + tipo; clips normales la primera línea del caption.
function buildYtTitle(entry, index) {
  let title;
  if (entry.type === 'set-export') {
    const name = entry.setName || entry.fileName || 'Set';
    if (entry.exportType === 'reel') {
      const prior = Object.values(index || {}).filter(
        (e) => e && e.type === 'set-export' && e.exportType === 'reel' && e.setName === entry.setName && e.youtubeUrl
      ).length;
      title = `${name} — Highlights Pt.${prior + 1}`;
    } else {
      title = `${name} (${entry.exportType || 'set'})`;
    }
  } else {
    title = stripHtml(entry.caption || '').split('\n')[0].trim() || entry.fileName || 'Clip de Melee';
  }
  return title.slice(0, 90);
}

async function handleYoutubeUpload(token, callbackQuery, isShort) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const key = String(messageId);
  const entry = loadIndex()[key];

  if (!entry) {
    await answerCallbackQuery(token, callbackQuery.id, '❌ Clip no encontrado');
    return;
  }
  if (ytInFlight.has(key)) {
    await answerCallbackQuery(token, callbackQuery.id, '⏳ Ya se está subiendo a YouTube...');
    return;
  }
  ytInFlight.add(key);
  await answerCallbackQuery(token, callbackQuery.id, '⏳ Subiendo a YouTube...');

  // Estado "subiendo" en el mensaje
  const editMessage = entry.isText ? editMessageText : editMessageCaption;
  await editMessage(
    token,
    chatId,
    messageId,
    `${entry.caption}\n\n⏳ <b>Subiendo a YouTube…</b>`,
    clipKeyboard(messageId, { uploading: true, youtubeUrl: entry.youtubeUrl })
  ).catch(() => {});

  // Cola secuencial: una subida a la vez aunque se pulsen varios botones.
  ytUploadChain = ytUploadChain.then(() => doYoutubeUpload(token, chatId, messageId, isShort));
}

async function doYoutubeUpload(token, chatId, messageId, isShort) {
  const key = String(messageId);
  try {
    const index = loadIndex();
    const entry = index[key];
    if (!entry) throw new Error('Clip no encontrado en el índice');
    if (!entry.filePath || !fs.existsSync(entry.filePath)) throw new Error('El archivo ya no existe en disco');

    const { url } = await uploadVideo({
      filePath: entry.filePath,
      title: buildYtTitle(entry, index),
      description: stripHtml(entry.caption || ''),
      isShort,
      privacy: 'private', // apps OAuth sin verificar de Google solo pueden subir private
      tags: ['melee', 'slippi', 'ssbm'],
      jobId: findExportJobId(entry.filePath) || undefined, // aplica thumbnail si existe
    });

    entry.youtubeUrl = url;
    saveIndex(index);

    const editMessage = entry.isText ? editMessageText : editMessageCaption;
    await editMessage(
      token,
      chatId,
      messageId,
      `${entry.caption}\n\n📺 ${url}`,
      clipKeyboard(messageId, { youtubeUrl: url })
    );
    console.log(`[bot] Subido a YouTube: ${entry.fileName} -> ${url}`);

    // Mensaje aparte con los detalles de la subida.
    const clipDesc = stripHtml(entry.caption || '').slice(0, 800);
    await sendMessage(
      token,
      chatId,
      `✅ <b>Subido a YouTube</b> ${isShort ? '(Short)' : '(Video)'}\n\n📌 <b>${escapeHtml(buildYtTitle(entry, index))}</b>\n📺 ${url}\n\n📝 ${escapeHtml(clipDesc)}`,
      { inline_keyboard: [[{ text: '🔗 Ver en YouTube', url }]] }
    ).catch(() => {});
  } catch (err) {
    console.error('[bot] Error subiendo a YouTube:', err);
    const msg = String(err.message || err).slice(0, 200);
    const entry = loadIndex()[key];
    if (entry) {
      const editMessage = entry.isText ? editMessageText : editMessageCaption;
      await editMessage(
        token,
        chatId,
        messageId,
        `${entry.caption}\n\n❌ <b>Error subiendo:</b> ${escapeHtml(msg)}`,
        clipKeyboard(messageId, { youtubeUrl: entry.youtubeUrl })
      ).catch(() => {});
    }
    await sendMessage(token, chatId, `❌ Error subiendo a YouTube: ${escapeHtml(msg)}`).catch(() => {});
  } finally {
    ytInFlight.delete(key);
  }
}

// ── Flujo de aprobación de exports (approvals.json) ─────────────────────────

// Edita el caption/texto del mensaje del approval según cómo se envió.
async function editApprovalMessage(token, approval, text, replyMarkup) {
  const editMessage = approval.isText ? editMessageText : editMessageCaption;
  await editMessage(token, approval.chatId, approval.messageId, text, replyMarkup);
}

// ✅ Subir a YouTube: encola la subida (secuencial, comparte ytUploadChain).
async function handleApprovalUpload(token, callbackQuery, approvalId) {
  const approval = approvals.getApproval(approvalId);
  if (!approval) {
    await answerCallbackQuery(token, callbackQuery.id, '❌ Approval no encontrado');
    return;
  }
  if (approval.status !== 'pending') {
    await answerCallbackQuery(token, callbackQuery.id, `Ya está ${approval.status === 'uploaded' ? 'subido' : 'descartado'}`);
    return;
  }
  const key = `appr:${approvalId}`;
  if (ytInFlight.has(key)) {
    await answerCallbackQuery(token, callbackQuery.id, '⏳ Ya se está subiendo a YouTube...');
    return;
  }
  ytInFlight.add(key);
  await answerCallbackQuery(token, callbackQuery.id, '⏳ Subiendo a YouTube...');

  await editApprovalMessage(
    token,
    approval,
    `${buildApprovalCaption(approval)}\n\n⏳ <b>Subiendo a YouTube…</b>`,
    { inline_keyboard: [[{ text: '⏳ Subiendo a YouTube…', callback_data: `appr_busy:${approvalId}` }]] }
  ).catch(() => {});

  ytUploadChain = ytUploadChain.then(() => doApprovalUpload(token, approvalId));
}

async function doApprovalUpload(token, approvalId) {
  const key = `appr:${approvalId}`;
  try {
    const approval = approvals.getApproval(approvalId);
    if (!approval) throw new Error('Approval no encontrado');
    if (!approval.filePath || !fs.existsSync(approval.filePath)) throw new Error('El archivo ya no existe en disco');

    const { url } = await uploadVideo({
      filePath: approval.filePath,
      title: approval.title,
      description: approval.description,
      tags: approval.tags,
      isShort: approval.type === 'reel',
      privacy: 'private', // apps OAuth sin verificar de Google solo pueden subir private
      jobId: findExportJobId(approval.filePath) || undefined, // aplica thumbnail si existe
    });

    const updated = approvals.updateApproval(approvalId, { status: 'uploaded', youtubeUrl: url });

    // Reflejar en el calendario del dashboard: entry ya 'uploaded' (no pasa
    // por render ni por el tick del scheduler).
    try {
      createScheduleEntry({
        setId: updated.setId,
        name: updated.setName || updated.title,
        type: updated.type,
        title: updated.title,
        description: updated.description,
        tags: updated.tags,
        publishAt: new Date().toISOString(),
        status: 'uploaded',
        outputPath: updated.filePath,
        jobId: findExportJobId(updated.filePath) || null,
        youtubeUrl: url,
      });
    } catch (e) {
      console.error('[bot] No se pudo registrar la subida en el calendario:', e.message);
    }
    await editApprovalMessage(
      token,
      updated,
      `${buildApprovalCaption(updated)}\n\n📺 ${url}`,
      { inline_keyboard: [[{ text: '🔗 Ver en YouTube', url }]] }
    );
    console.log(`[bot] Approval subido a YouTube: ${approval.filePath} -> ${url}`);

    // Mensaje aparte con todos los detalles de la subida.
    const desc = (updated.description || '').slice(0, 800);
    await sendMessage(
      token,
      updated.chatId,
      `✅ <b>Subido a YouTube</b>\n\n📌 <b>${escapeHtml(updated.title || '(sin título)')}</b>\n📺 ${url}\n\n📝 ${escapeHtml(desc)}${(updated.description || '').length > 800 ? '…' : ''}\n\n🏷️ ${escapeHtml((updated.tags || []).join(', '))}`,
      { inline_keyboard: [[{ text: '🔗 Ver en YouTube', url }]] }
    ).catch(() => {});
  } catch (err) {
    console.error('[bot] Error subiendo approval a YouTube:', err);
    const msg = String(err.message || err).slice(0, 200);
    const approval = approvals.getApproval(approvalId);
    if (approval) {
      await editApprovalMessage(
        token,
        approval,
        `${buildApprovalCaption(approval)}\n\n❌ <b>Error subiendo:</b> ${escapeHtml(msg)}`,
        approvals.approvalKeyboard(approvalId)
      ).catch(() => {});
      await sendMessage(token, approval.chatId, `❌ Error subiendo a YouTube: ${escapeHtml(msg)}`).catch(() => {});
    }
  } finally {
    ytInFlight.delete(key);
  }
}

// ✏️ Título / 📝 Descripción: arma pendingEdit y pide el texto.
async function handleApprovalEdit(token, callbackQuery, approvalId, field) {
  const approval = approvals.getApproval(approvalId);
  if (!approval) {
    await answerCallbackQuery(token, callbackQuery.id, '❌ Approval no encontrado');
    return;
  }
  if (approval.status !== 'pending') {
    await answerCallbackQuery(token, callbackQuery.id, 'Ya no se puede editar (subido o descartado)');
    return;
  }
  const chatId = String(callbackQuery.message.chat.id);
  pendingEdits[chatId] = { approvalId, field };
  await answerCallbackQuery(token, callbackQuery.id, '✏️ Esperando tu texto...');
  const label = field === 'title' ? 'título' : 'descripción';
  // La descripción de un full-set (capítulos de 17+ juegos) pasa de largo los
  // 200 chars; Telegram permite mensajes de 4096, así que le damos espacio.
  const maxLen = field === 'description' ? 3000 : 200;
  const current = String(approval[field] || '');
  const preview = current.length > maxLen ? `${current.slice(0, maxLen)}…` : current;
  await sendMessage(token, chatId, `Mandame el nuevo <b>${label}</b> como mensaje de texto.\n\n<b>Valor actual:</b>\n${escapeHtml(preview)}`);
}

// 📅 Programar: pide fecha/hora y crea una entry 'rendered' en schedule.json
// (el export ya existe, no hay que re-renderizar nada).
async function handleApprovalSchedule(token, callbackQuery, approvalId) {
  const approval = approvals.getApproval(approvalId);
  if (!approval) {
    await answerCallbackQuery(token, callbackQuery.id, '❌ Approval no encontrado');
    return;
  }
  if (approval.status !== 'pending') {
    await answerCallbackQuery(token, callbackQuery.id, 'Ya no se puede programar (subido, programado o descartado)');
    return;
  }
  const chatId = String(callbackQuery.message.chat.id);
  pendingSchedules[chatId] = { approvalId };
  await answerCallbackQuery(token, callbackQuery.id, '📅 Esperando fecha...');
  await sendMessage(
    token,
    chatId,
    `📅 ¿Cuándo lo subo a YouTube? Mandame fecha y hora así:\n<code>2026-08-25 18:00</code>\n(hora de RD). Si no pones hora, se usa 18:00.`
  );
}

// Parsea "YYYY-MM-DD HH:MM" (hora RD, UTC-4) a ISO UTC. null si no cuadra.
function parseRdDateTime(text) {
  const m = text.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h = '18', mi = '0'] = m;
  const utcMs = Date.UTC(+y, +mo - 1, +d, +h + RD_TZ_OFFSET_H, +mi);
  const date = new Date(utcMs);
  return Number.isFinite(date.getTime()) ? date : null;
}

// El próximo mensaje de texto tras 📅 Programar crea la entry del calendario.
async function handlePendingSchedule(token, msg) {
  const chatId = String(msg.chat.id);
  const pending = pendingSchedules[chatId];
  delete pendingSchedules[chatId];

  const approval = approvals.getApproval(pending.approvalId);
  if (!approval || approval.status !== 'pending') {
    await sendMessage(token, chatId, '❌ El approval ya no está pendiente, no se programó nada.');
    return;
  }
  const publishAt = parseRdDateTime(msg.text);
  if (!publishAt) {
    await sendMessage(token, chatId, '❌ Fecha inválida. Formato: <code>2026-08-25 18:00</code>. Vuelve a darle 📅 Programar.');
    return;
  }
  if (publishAt.getTime() < Date.now() + 5 * 60 * 1000) {
    await sendMessage(token, chatId, '❌ Esa fecha ya pasó (o falta menos de 5 min). Vuelve a darle 📅 Programar.');
    return;
  }

  const entry = createScheduleEntry({
    setId: approval.setId,
    name: approval.setName || approval.title,
    type: approval.type,
    title: approval.title,
    description: approval.description,
    tags: approval.tags,
    publishAt: publishAt.toISOString(),
    status: 'rendered', // ya está renderizado: el scheduler solo espera y sube
    outputPath: approval.filePath,
    jobId: findExportJobId(approval.filePath) || null,
  });
  const updated = approvals.updateApproval(approval.id, { status: 'scheduled' });
  const rdTime = msg.text.trim();
  await editApprovalMessage(
    token,
    updated,
    `${buildApprovalCaption(updated)}\n\n📅 <b>Programado para ${escapeHtml(rdTime)} (hora RD)</b>`,
    { inline_keyboard: [[{ text: `📅 Programado: ${rdTime}`, callback_data: `appr_busy:${approval.id}` }]] }
  ).catch((e) => console.error('[bot] No se pudo re-editar approval programado:', e.message));
  await sendMessage(token, chatId, `✅ Programado para <b>${escapeHtml(rdTime)}</b> (hora RD). Aparece en el calendario del dashboard y sube solo a esa hora.`);
  console.log(`[bot] Approval ${approval.id} programado: entry ${entry.id}, publishAt ${entry.publishAt}`);
}

// El próximo mensaje de texto plano del chat aplica el pendingEdit.
async function handlePendingEdit(token, msg) {
  const chatId = String(msg.chat.id);
  const pending = pendingEdits[chatId];
  delete pendingEdits[chatId];

  const approval = approvals.getApproval(pending.approvalId);
  if (!approval) {
    await sendMessage(token, chatId, '❌ Approval no encontrado, edición descartada.');
    return;
  }
  if (approval.status !== 'pending') {
    await sendMessage(token, chatId, '❌ El approval ya no está pendiente, edición descartada.');
    return;
  }
  const value = msg.text.trim();
  if (!value) {
    await sendMessage(token, chatId, '❌ Texto vacío, no se actualizó nada.');
    return;
  }
  const patch = pending.field === 'title' ? { title: value.slice(0, 100) } : { description: value };
  const updated = approvals.updateApproval(pending.approvalId, patch);

  // Re-edita el caption del video mostrando la metadata actualizada.
  if (updated.messageId && updated.chatId) {
    await editApprovalMessage(token, updated, buildApprovalCaption(updated), approvals.approvalKeyboard(updated.id)).catch((e) => {
      console.error('[bot] No se pudo re-editar caption del approval:', e.message);
    });
  }
  const label = pending.field === 'title' ? 'Título' : 'Descripción';
  await sendMessage(token, chatId, `✅ ${label} actualizado.`);
}

// ❌ Descartar: marca discarded y quita botones.
async function handleApprovalDiscard(token, callbackQuery, approvalId) {
  const approval = approvals.getApproval(approvalId);
  if (!approval) {
    await answerCallbackQuery(token, callbackQuery.id, '❌ Approval no encontrado');
    return;
  }
  if (approval.status !== 'pending') {
    await answerCallbackQuery(token, callbackQuery.id, `Ya está ${approval.status === 'uploaded' ? 'subido' : 'descartado'}`);
    return;
  }
  const updated = approvals.updateApproval(approvalId, { status: 'discarded' });
  await answerCallbackQuery(token, callbackQuery.id, '❌ Descartado');
  await editApprovalMessage(
    token,
    updated,
    `${buildApprovalCaption(updated)}\n\n❌ <b>Descartado</b>`,
    { inline_keyboard: [] }
  ).catch(() => {});
}

async function processUpdate(update, token) {
  if (update.callback_query) {
    const cb = update.callback_query;
    if (!isAllowedChat(cb.message?.chat?.id)) {
      console.warn('[bot] callback de chat no autorizado:', cb.message?.chat?.id, cb.from?.username || '');
      return;
    }
    if (cb.data && (cb.data.startsWith('add_compile:') || cb.data.startsWith('toggle_compile:') || cb.data.startsWith('remove_compile:'))) {
      await handleToggleCompile(token, cb);
    } else if (cb.data && cb.data.startsWith('yt_short:')) {
      await handleYoutubeUpload(token, cb, true);
    } else if (cb.data && cb.data.startsWith('yt_video:')) {
      await handleYoutubeUpload(token, cb, false);
    } else if (cb.data && cb.data.startsWith('yt_busy:')) {
      await answerCallbackQuery(token, cb.id, '⏳ Ya se está subiendo a YouTube...');
    } else if (cb.data && cb.data.startsWith('appr_upload:')) {
      await handleApprovalUpload(token, cb, cb.data.slice('appr_upload:'.length));
    } else if (cb.data && cb.data.startsWith('appr_sched:')) {
      await handleApprovalSchedule(token, cb, cb.data.slice('appr_sched:'.length));
    } else if (cb.data && cb.data.startsWith('appr_title:')) {
      await handleApprovalEdit(token, cb, cb.data.slice('appr_title:'.length), 'title');
    } else if (cb.data && cb.data.startsWith('appr_desc:')) {
      await handleApprovalEdit(token, cb, cb.data.slice('appr_desc:'.length), 'description');
    } else if (cb.data && cb.data.startsWith('appr_discard:')) {
      await handleApprovalDiscard(token, cb, cb.data.slice('appr_discard:'.length));
    } else if (cb.data && cb.data.startsWith('appr_busy:')) {
      await answerCallbackQuery(token, cb.id, '⏳ Ya se está subiendo a YouTube...');
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;
  if (!isAllowedChat(msg.chat?.id)) {
    console.warn('[bot] mensaje de chat no autorizado:', msg.chat?.id, msg.from?.username || '', JSON.stringify(msg.text || '').slice(0, 80));
    return;
  }

  // El mismo mensaje llega por el polling de cada bot: procesar una sola vez.
  const msgKey = `${msg.chat.id}:${msg.message_id}`;
  if (seenMessages.has(msgKey)) return;
  seenMessages.add(msgKey);
  setTimeout(() => seenMessages.delete(msgKey), 60000).unref();

  // Voice note como respuesta a un clip -> voice over
  if (msg.voice && msg.reply_to_message) {
    await handleVoiceNote(token, msg.chat.id, msg.voice, msg.reply_to_message.message_id);
    return;
  }

  // Foto como respuesta a un clip/export -> thumbnail de YouTube
  if (msg.photo && msg.reply_to_message) {
    await handleThumbnailPhoto(token, msg);
    return;
  }

  if (!msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // ¿Hay una programación pendiente para este chat? (📅 de approvals)
  if (pendingSchedules[String(chatId)] && !text.startsWith('/')) {
    await handlePendingSchedule(token, msg);
    return;
  }

  // ¿Hay una edición de metadata pendiente para este chat? (✏️/📝 de approvals)
  if (pendingEdits[String(chatId)] && !text.startsWith('/')) {
    await handlePendingEdit(token, msg);
    return;
  }

  const [command, ...args] = text.split(/\s+/);
  const argsText = args.join(' ');

  switch (command.toLowerCase()) {
    case '/list':
    case '/lista':
      await handleList(token, chatId);
      break;
    case '/clear':
    case '/limpiar':
      await handleClear(token, chatId);
      break;
    case '/compile':
    case '/compilar':
      await handleCompile(token, chatId, argsText);
      break;
    case '/status':
    case '/estado':
      await handleStatus(token, chatId);
      break;
    case '/start':
    case '/help':
    case '/ayuda':
      await handleHelp(token, chatId);
      break;
  }
}

// Elimina del índice entradas cuyo archivo ya no existe en disco.
function pruneIndex() {
  const index = loadIndex();
  let removed = 0;
  for (const [id, entry] of Object.entries(index)) {
    if (!entry.filePath || !fs.existsSync(entry.filePath)) {
      delete index[id];
      removed++;
    }
  }
  if (removed > 0) saveIndex(index);
  console.log(`[bot] Índice de clips: ${Object.keys(index).length} entradas, ${removed} huérfanas eliminadas`);
}

async function poll(token) {
  let offset = 0;
  console.log(`[bot] Iniciando polling de Telegram (bot ...${token.slice(-8)})...`);

  while (true) {
    try {
      const res = await fetch(`${apiUrl(token)}/getUpdates?offset=${offset}&limit=10&allowed_updates=${encodeURIComponent(JSON.stringify(['message', 'callback_query']))}`);
      const data = await res.json();
      if (!data.ok) {
        console.error('[bot] getUpdates error:', data);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      for (const update of data.result) {
        offset = Math.max(offset, update.update_id + 1);
        try {
          await processUpdate(update, token);
        } catch (e) {
          console.error('[bot] Error procesando update:', e);
        }
      }
    } catch (e) {
      console.error('[bot] Polling error:', e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

pruneIndex();
for (const token of BOT_TOKENS) {
  poll(token).catch((err) => {
    console.error('[bot] Error fatal:', err);
    process.exit(1);
  });
}
