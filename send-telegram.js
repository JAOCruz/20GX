// send-telegram.js
// Envía videos de clips por Telegram usando un bot.
//
// Uso:
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node send-telegram.js <video-file-or-folder>
//
// Para obtener tu chat ID, primero enviale un mensaje al bot y luego corre:
//   TELEGRAM_BOT_TOKEN=... node send-telegram.js --get-chat-id

const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INDEX_FILE = process.env.TELEGRAM_CLIP_INDEX || path.join(__dirname, 'telegram-clip-index.json');

if (!BOT_TOKEN) {
  console.error('Falta TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function saveIndex(index) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

async function getChatIds() {
  const res = await fetch(`${API}/getUpdates`);
  const data = await res.json();
  if (!data.ok) {
    console.error('Error getUpdates:', data);
    return;
  }
  const chats = new Map();
  for (const upd of data.result) {
    const chat = upd.message?.chat || upd.callback_query?.message?.chat;
    if (chat) {
      chats.set(chat.id, `${chat.type}: ${chat.username || chat.first_name || chat.title} (id=${chat.id})`);
    }
  }
  console.log('Chats encontrados:');
  for (const [id, label] of chats) {
    console.log(`  ${id} -> ${label}`);
  }
}

function buildCaptionForFile(videoPath, providedCaption) {
  if (providedCaption) return escapeHtml(providedCaption);
  const manifest = loadManifestForFile(videoPath);
  if (manifest) return buildCaption(manifest, path.basename(videoPath));
  return escapeHtml(path.basename(videoPath));
}

async function sendVideo(chatId, videoPath, caption) {
  const index = loadIndex();
  const absolutePath = path.resolve(videoPath);

  // Evitar reenviar el mismo archivo si ya fue enviado antes.
  const alreadySent = Object.values(index).find((entry) => entry.filePath === absolutePath);
  if (alreadySent) {
    console.log(`[telegram] Ya enviado previamente, saltando: ${path.basename(videoPath)} (msg ${alreadySent.messageId || '?'})`);
    return;
  }

  const safeCaption = buildCaptionForFile(videoPath, caption);
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', safeCaption);
  form.append('parse_mode', 'HTML');
  form.append('supports_streaming', 'true');
  form.append(
    'video',
    new Blob([fs.readFileSync(videoPath)], { type: 'video/mp4' }),
    path.basename(videoPath)
  );
  form.append(
    'reply_markup',
    JSON.stringify({
      inline_keyboard: [
        [{ text: '➕ Añadir a compilado', callback_data: 'toggle_compile:__PENDING__' }],
        [
          { text: '⬆️ Short', callback_data: 'yt_short:__PENDING__' },
          { text: '⬆️ Video', callback_data: 'yt_video:__PENDING__' },
        ],
      ],
    })
  );

  const res = await fetch(`${API}/sendVideo`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram error: ${data.error_code} ${data.description}`);
  }

  const messageId = data.result.message_id;
  index[String(messageId)] = {
    chatId,
    filePath: absolutePath,
    fileName: path.basename(videoPath),
    caption: safeCaption,
    sentAt: new Date().toISOString(),
  };
  saveIndex(index);

  // Actualizar el botón con el message_id real
  await fetch(`${API}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Añadir a compilado', callback_data: `toggle_compile:${messageId}` }],
          [
            { text: '⬆️ Short', callback_data: `yt_short:${messageId}` },
            { text: '⬆️ Video', callback_data: `yt_video:${messageId}` },
          ],
        ],
      },
    }),
  });

  console.log(`[telegram] Enviado: ${path.basename(videoPath)} -> chat ${chatId} (msg ${messageId})`);
}

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function loadManifestForFile(videoPath) {
  const folderPath = path.dirname(videoPath);
  const baseName = path.basename(videoPath, '.mp4').replace(/_stock\d+$/, '').replace(/_all-stocks$/, '').replace(/_selected-stocks$/, '');

  // Manifest de stocks seleccionados desde el dashboard
  const selectedPath = path.join(folderPath, 'selected-stocks-manifest.json');
  if (fs.existsSync(selectedPath)) {
    try {
      return JSON.parse(fs.readFileSync(selectedPath, 'utf-8'));
    } catch (e) {
      return null;
    }
  }

  const manifestPath = path.join(folderPath, `${baseName}-manifest.json`);
  if (fs.existsSync(manifestPath)) {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (e) {
      return null;
    }
  }
  // Fallback al manifest antiguo
  const legacyPath = path.join(folderPath, 'stock-clips-manifest.json');
  if (fs.existsSync(legacyPath)) {
    try {
      return JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
    } catch (e) {
      return null;
    }
  }
  return null;
}

function buildCaption(manifest, fileName) {
  if (!manifest) return escapeHtml(fileName);
  const clip = manifest.clips.find((c) => c.file === fileName);
  const stockInfo = clip ? `Stock ${clip.id.replace('stock', '')} (~${formatTime(clip.stockTimeSeconds)})` : '';
  const a = escapeHtml(manifest.attacker.name);
  const aChar = escapeHtml(manifest.attacker.charName);
  const v = escapeHtml(manifest.victim.name);
  const vChar = escapeHtml(manifest.victim.charName);
  const stage = escapeHtml(manifest.stage);
  const winner = escapeHtml(manifest.winner);
  return (
    `🥊 <b>${a}</b> (${aChar}) vs <b>${v}</b> (${vChar})\n` +
    `🏟️ ${stage}\n` +
    `⏱️ Partida: ${formatTime(manifest.durationSeconds)}\n` +
    `🏆 Ganador: ${winner}\n` +
    (stockInfo ? `💥 ${stockInfo}` : `🎬 Todos los stocks`)
  );
}

async function sendFolder(chatId, folderPath) {
  const files = fs
    .readdirSync(folderPath)
    .filter((f) => f.endsWith('.mp4'))
    .map((f) => path.join(folderPath, f))
    .sort();

  if (files.length === 0) {
    console.log('No hay videos para enviar.');
    return;
  }

  for (const file of files) {
    try {
      await sendVideo(chatId, file);
      // Pausa para no saturar rate limits
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      console.error(`[telegram] Error enviando ${path.basename(file)}:`, e.message);
    }
  }
}

async function main() {
  const input = process.argv[2];

  if (input === '--get-chat-id') {
    await getChatIds();
    return;
  }

  if (!CHAT_ID) {
    console.error('Falta TELEGRAM_CHAT_ID. Para obtenerlo:');
    console.error('  TELEGRAM_BOT_TOKEN=... node send-telegram.js --get-chat-id');
    process.exit(1);
  }

  if (!input) {
    console.error('Uso: node send-telegram.js <archivo.mp4 | carpeta>');
    process.exit(1);
  }

  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    await sendFolder(CHAT_ID, input);
  } else {
    await sendVideo(CHAT_ID, input, process.argv[3]);
  }
}

main().catch((err) => {
  console.error('[telegram] Error:', err);
  process.exit(1);
});
