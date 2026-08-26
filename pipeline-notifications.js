// pipeline-notifications.js
// Notificaciones estructuradas de eventos del pipeline de Slippi.
// Mensajes compactos, sin bullets feos, usando HTML soportado por Telegram.

const { sendTextMessage } = require('./notify-telegram');

const SEPARATOR = '─────────────';

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDate(date = new Date()) {
  return new Date(date).toLocaleString('es-DO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function renderItems(items) {
  return items.map((item) => `▫️ ${item}`).join('\n');
}

async function notifyRenderStarted({ jobId, totalStocks, games, options }) {
  const details = [`Stocks: <b>${totalStocks}</b>`, `Juegos: <b>${games.length}</b>`];
  if (options?.resolution) details.push(`Resolución: <b>${options.resolution}</b>`);
  if (options?.sendTelegram) details.push('Enviar a Telegram: <b>sí</b>');
  if (options?.mixDiscord) details.push('Mezclar audio Discord: <b>sí</b>');

  const text = [
    '🎬 <b>Render iniciado</b>',
    `${SEPARATOR}`,
    `Job: <code>${jobId}</code>`,
    renderItems(details),
    `${SEPARATOR}`,
    `<i>${formatDate()}</i>`,
  ].join('\n');

  await sendTextMessage(text, { html: true });
}

async function notifyRenderCompleted({ jobId, total, done, errors, elapsedSeconds }) {
  const details = [`Progreso: <b>${done}/${total}</b>`];
  if (elapsedSeconds != null) details.push(`Duración: <b>${formatDuration(elapsedSeconds)}</b>`);
  if (errors?.length > 0) details.push(`Errores: <b>${errors.length}</b>`);

  const text = [
    '✅ <b>Render completado</b>',
    `${SEPARATOR}`,
    `Job: <code>${jobId}</code>`,
    renderItems(details),
    `${SEPARATOR}`,
    `<i>${formatDate()}</i>`,
  ].join('\n');

  await sendTextMessage(text, { html: true });
}

async function notifyRenderFailed({ jobId, error }) {
  const text = [
    '❌ <b>Render fallido</b>',
    `${SEPARATOR}`,
    `Job: <code>${jobId}</code>`,
    `<pre>${error.slice(0, 400)}</pre>`,
    `${SEPARATOR}`,
    `<i>${formatDate()}</i>`,
  ].join('\n');

  await sendTextMessage(text, { html: true });
}

async function notifySessionStarted({ guildId, channelId }) {
  const text = [
    '🎮 <b>Sesión iniciada</b>',
    `${SEPARATOR}`,
    `Servidor: <code>${guildId}</code>`,
    `Canal: <code>${channelId}</code>`,
    `${SEPARATOR}`,
    `<i>${formatDate()}</i>`,
  ].join('\n');

  await sendTextMessage(text, { html: true });
}

async function notifySessionStopped({ recordedSeconds }) {
  const details = [];
  if (recordedSeconds != null) details.push(`Audio grabado: <b>${formatDuration(recordedSeconds)}</b>`);

  const text = [
    '🛑 <b>Sesión detenida</b>',
    `${SEPARATOR}`,
    ...(details.length ? [renderItems(details)] : []),
    `${SEPARATOR}`,
    `<i>${formatDate()}</i>`,
  ].join('\n');

  await sendTextMessage(text, { html: true });
}

async function notifyClipSent({ fileName }) {
  const text = [
    '📤 <b>Clip enviado</b>',
    `${SEPARATOR}`,
    fileName,
    `${SEPARATOR}`,
    `<i>${formatDate()}</i>`,
  ].join('\n');

  await sendTextMessage(text, { html: true });
}

async function notifyAiStatus(title, items = []) {
  const body = items.length ? renderItems(items) : '';
  const text = [
    '🤖 <b>Kimi — ' + title + '</b>',
    `${SEPARATOR}`,
    body,
    `${SEPARATOR}`,
    `<i>${formatDate()}</i>`,
  ].join('\n');

  await sendTextMessage(text, { html: true });
}

module.exports = {
  notifyRenderStarted,
  notifyRenderCompleted,
  notifyRenderFailed,
  notifySessionStarted,
  notifySessionStopped,
  notifyClipSent,
  notifyAiStatus,
};
