// sets-store.js
// Persistencia de "sets" (series de juegos entre dos jugadores, ej. FT10)
// en sets.json con escritura atómica (tmp + rename). Tolera archivo
// faltante o corrupto devolviendo una lista vacía.

const fs = require('fs');
const path = require('path');

const SETS_FILE = path.join(__dirname, 'sets.json');

function loadSets() {
  if (!fs.existsSync(SETS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(SETS_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[sets-store] sets.json corrupto, ignorando:', e.message);
    return [];
  }
}

function saveSets(sets) {
  const tmp = `${SETS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sets, null, 2));
  fs.renameSync(tmp, SETS_FILE);
}

function listSets() {
  return loadSets().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

function getSet(id) {
  return loadSets().find((s) => s.id === id) || null;
}

function createSet(data) {
  const sets = loadSets();
  const set = {
    id: `set-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: data.name || 'Set sin nombre',
    createdAt: new Date().toISOString(),
    source: data.source || 'manual',
    players: data.players || [],
    gamePaths: data.gamePaths || [],
    wins: data.wins || [0, 0],
    format: data.format || null,
    date: data.date || null,
    storyNotes: data.storyNotes || null,
  };
  sets.push(set);
  saveSets(sets);
  return set;
}

function updateSet(id, patch) {
  const sets = loadSets();
  const idx = sets.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  sets[idx] = { ...sets[idx], ...patch, id: sets[idx].id, createdAt: sets[idx].createdAt, source: sets[idx].source };
  saveSets(sets);
  return sets[idx];
}

function deleteSet(id) {
  const sets = loadSets();
  const filtered = sets.filter((s) => s.id !== id);
  if (filtered.length === sets.length) return false;
  saveSets(filtered);
  return true;
}

// Slug seguro para nombres de archivo a partir del nombre del set.
function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // marcas diacríticas (U+0300–U+036F)
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'set';
}

// Nombre automático: "HARD#123 vs DOLF#456 — 2026-07-18"
function autoName(players, dateIso) {
  const names = (players || []).map((p) => p.connectCode || '?').join(' vs ');
  const day = dateIso ? String(dateIso).slice(0, 10) : new Date().toISOString().slice(0, 10);
  return `${names} — ${day}`;
}

module.exports = {
  SETS_FILE,
  loadSets,
  saveSets,
  listSets,
  getSet,
  createSet,
  updateSet,
  deleteSet,
  slugify,
  autoName,
};
