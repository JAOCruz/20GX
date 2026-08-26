// youtube-metadata.js
// Genera título / descripción / tags de YouTube para exports de sets,
// a partir del set (sets-store) + stocks/juegos incluidos.
//
//   reel:     "<SetName> - Highlights Pt.N" (N = reels ya subidos del set + 1)
//   full-set: "PLAYER1 (Char) vs PLAYER2 (Char) - FT10 | Super Smash Bros. Melee"
//             con capítulos por juego (timestamps de las duraciones).
//
// Si el set tiene storyNotes, se incluye como contexto en la descripción.

const path = require('path');
const { Character } = require('@slippi/slippi-js');
const { getGameStocks } = require('./sets-stocks');
const { countUploadedReels } = require('./approvals');
const { escapeHtml } = require('./notify-telegram');

function charName(id) {
  const name = Character[id];
  return typeof name === 'string' ? name : `Char ${id}`;
}

// Timestamp de capítulo YouTube: m:ss (o h:mm:ss si pasa la hora).
function chapterTimestamp(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

function playerLabel(p, fallbackName) {
  if (!p) return '?';
  let name = p.connectCode || '?';
  // Replays offline no tienen connect code ('P1'/'P2'): usar nombre del set.
  if (/^P\d+$/i.test(name) && fallbackName) name = fallbackName;
  return `${name} (${charName(p.characterId)})`;
}

// Jugadores del set; si el set no los tiene, se derivan del primer juego.
function resolvePlayers(set, items) {
  if (set?.players?.length >= 2) return set.players;
  const gamePath = items?.[0]?.gamePath || set?.gamePaths?.[0];
  if (!gamePath) return [];
  try {
    return getGameStocks(gamePath).players || [];
  } catch (e) {
    return [];
  }
}

// "CUENTI vs LEIN — FT10 (2026-07-26)" -> ['CUENTI', 'LEIN']
function namesFromSetName(setName) {
  const head = String(setName || '').split(/[—(]/)[0];
  const parts = head.split(/\s+vs\s+/i);
  return parts.length === 2 ? parts.map((s) => s.trim()) : null;
}

// Formato del set ('FT10'); fallback: extraerlo del nombre.
function resolveFormat(set, setName) {
  if (set?.format) return set.format;
  const m = String(setName || '').match(/\bFT\d+\b/i);
  return m ? m[0].toUpperCase() : 'FT10';
}

// Duración de un juego en segundos (del análisis de stocks; fallback 4 min).
function gameDurationSec(gamePath) {
  try {
    const d = getGameStocks(gamePath).durationSec;
    return typeof d === 'number' && d > 0 ? d : 240;
  } catch (e) {
    return 240;
  }
}

function baseTags(set, players, fallbackNames) {
  const tags = ['melee', 'slippi', 'ssbm', 'super smash bros melee'];
  (players?.length ? players : set?.players || []).forEach((p, i) => {
    const code = p.connectCode && !/^P\d+$/i.test(p.connectCode)
      ? String(p.connectCode).replace(/#/g, '').toLowerCase()
      : (fallbackNames?.[i] || '').toLowerCase();
    if (code) tags.push(code);
    const c = charName(p.characterId);
    if (c && !c.startsWith('Char ')) tags.push(c.toLowerCase());
  });
  return [...new Set(tags)];
}

/**
 * Genera { title, description, tags } para un export.
 * @param {object} opts
 * @param {object|null} opts.set    Set de sets-store (puede ser null)
 * @param {string}      opts.type   'reel' | 'full-set'
 * @param {Array}       opts.items  Items del export ([{ gamePath, stockId? }])
 * @param {string}      [opts.name] Nombre del export (fallback al del set)
 */
function generateMetadata({ set, type, items = [], name }) {
  const setName = name || set?.name || 'Set';
  const players = resolvePlayers(set, items);
  const fallbackNames = namesFromSetName(setName);
  const labels = [playerLabel(players[0], fallbackNames?.[0]), playerLabel(players[1], fallbackNames?.[1])];
  const tags = baseTags(set, players, fallbackNames);
  const story = set?.storyNotes ? String(set.storyNotes).trim() : '';

  if (type === 'reel') {
    const partN = set?.id ? countUploadedReels(set.id) + 1 : 1;
    const description = [
      `Highlights de ${setName}: ${labels[0]} vs ${labels[1]}.`,
      story,
      '',
      'Grabado con Slippi / renderizado headless.',
    ].filter(Boolean).join('\n');
    return {
      title: `${setName} - Highlights Pt.${partN}`.slice(0, 100),
      description,
      tags,
    };
  }

  // full-set
  const format = resolveFormat(set, setName);
  const title = `${labels[0]} vs ${labels[1]} - ${format} | Super Smash Bros. Melee`.slice(0, 100);

  const chapters = [];
  let acc = 0;
  items.forEach((item, i) => {
    let stage = null;
    try {
      stage = getGameStocks(item.gamePath).stage;
    } catch (e) { /* sin datos de stage */ }
    const label = stage ? `Juego ${i + 1} - ${stage}` : `Juego ${i + 1}`;
    chapters.push(`${chapterTimestamp(acc)} ${label}`);
    acc += gameDurationSec(item.gamePath);
  });

  const description = [
    story,
    `${labels[0]} vs ${labels[1]} — ${format}.`,
    chapters.length ? `\nCapítulos:\n${chapters.join('\n')}` : '',
  ].filter(Boolean).join('\n');

  return { title, description, tags };
}

// Caption de Telegram del approval: muestra la metadata generada para que el
// usuario la revise antes de aprobar la subida. Trunca la descripción para no
// pasar el límite de 1024 chars de captions de la Bot API.
function buildApprovalCaption(approval) {
  const desc = String(approval.description || '');
  const descShown = desc.length > 400 ? `${desc.slice(0, 400)}…` : desc;
  const lines = [];
  if (approval.header) lines.push(approval.header);
  lines.push(`📺 <b>TÍTULO:</b> ${escapeHtml(approval.title)}`);
  lines.push(`📝 <b>DESCRIPCIÓN:</b>\n${escapeHtml(descShown) || '<i>(vacía)</i>'}`);
  lines.push(`🏷️ ${escapeHtml((approval.tags || []).join(', '))}`);
  return lines.join('\n').slice(0, 1000);
}

module.exports = {
  generateMetadata,
  buildApprovalCaption,
  chapterTimestamp,
  charName,
};
