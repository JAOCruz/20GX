// notify-telegram.js
// Envía mensajes de texto simples por Telegram para notificaciones de estado.
//
// Uso:
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node notify-telegram.js "Mensaje"
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node notify-telegram.js --html "<b>Negrita</b>"
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node notify-telegram.js --file mensaje.txt

const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8988066588:AAGmnziOt1ATk9j8IseiAxHyyA50DCq-kgU';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '6932565341';
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendTextMessage(text, options = {}) {
  const { html = false, disableNotification = false } = options;
  const body = {
    chat_id: options.chatId || CHAT_ID,
    text: html ? text : escapeHtml(text),
    parse_mode: html ? 'HTML' : 'HTML',
    disable_notification: disableNotification,
  };
  if (options.replyMarkup) body.reply_markup = options.replyMarkup;

  const api = options.token ? `https://api.telegram.org/bot${options.token}` : API;
  const res = await fetch(`${api}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram error: ${data.error_code} ${data.description}`);
  }
  return data.result;
}

// Envía un archivo de video con caption (sendVideo). A diferencia de
// send-telegram.js, no lleva índice anti-duplicados: pensado para
// compilaciones de sets que se envían una sola vez. Acepta
// options.replyMarkup para adjuntar botones inline.
async function sendVideoMessage(videoPath, caption, options = {}) {
  const api = options.token ? `https://api.telegram.org/bot${options.token}` : API;
  const form = new FormData();
  form.append('chat_id', options.chatId || CHAT_ID);
  // El caption YA viene con HTML intencional (los callers escapan su contenido
  // dinámico). Escaparlo aquí dejaba los <b> visibles como texto.
  form.append('caption', caption || path.basename(videoPath));
  form.append('parse_mode', 'HTML');
  form.append('supports_streaming', 'true');
  if (options.replyMarkup) form.append('reply_markup', JSON.stringify(options.replyMarkup));
  form.append(
    'video',
    new Blob([fs.readFileSync(videoPath)], { type: 'video/mp4' }),
    path.basename(videoPath)
  );

  const res = await fetch(`${api}/sendVideo`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram error: ${data.error_code} ${data.description}`);
  }
  return data.result;
}

async function main() {
  const args = process.argv.slice(2);
  let html = false;
  let text = '';

  if (args[0] === '--html') {
    html = true;
    text = args.slice(1).join(' ');
  } else if (args[0] === '--file' && args[1]) {
    text = fs.readFileSync(args[1], 'utf-8');
  } else {
    text = args.join(' ');
  }

  if (!text.trim()) {
    console.error('Uso: node notify-telegram.js [--html] "mensaje"');
    process.exit(1);
  }

  const result = await sendTextMessage(text, { html });
  console.log(`[notify-telegram] Enviado msg ${result.message_id} a chat ${CHAT_ID}`);
}

module.exports = { sendTextMessage, sendVideoMessage, escapeHtml };

if (require.main === module) {
  main().catch((err) => {
    console.error('[notify-telegram] Error:', err.message);
    process.exit(1);
  });
}
