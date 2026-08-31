// auto-shorts.js
// AUTO-SHORTS: generación automática de reels verticales (Shorts) con los
// mejores combos recientes, rankeados por las reglas de combo-ranking +
// bonus de ELO de Slippi (slippi-ratings.js).
//
// Flujo: tick() (cada 60s desde worker-server.js) → si enabled y pasaron
// >= frequencyDays desde lastRunAt y hay >= 3 candidatos, encola UN job
// 'set-export' (type 'reel', vertical, payload.autoShort = true) en la cola
// SQLite. Al terminar el render, set-export.js crea el approval y lo manda
// por Telegram con botones Aprobar/Editar/Descartar — solo se sube si Jay
// aprueba. Config persistida en auto-shorts.json (atómica tmp + rename).

const fs = require('fs');
const path = require('path');
const comboRanking = require('./combo-ranking');
const { loadCachedGames } = require('./scan-replays');
const { CACHE_FILE: STOCKS_CACHE_FILE } = require('./sets-stocks');
const ratings = require('./slippi-ratings');
const { charName } = require('./youtube-metadata');
const approvals = require('./approvals');

const CONFIG_FILE = path.join(__dirname, 'auto-shorts.json');
const FPS = 60;
const SLIPPI_FIRST_FRAME = -123; // frame mínimo de un replay (cuenta regresiva)
const MIN_CANDIDATES = 3; // mínimo de clips candidatos para generar

const DEFAULT_CONFIG = {
  enabled: true,
  frequencyDays: 3,
  targetDurationSec: 40,
  maxClips: 6,
  minComboLength: 3,
  // null = usar las reglas de combo-ranking.json
  rules: null,
  // vacío = cualquier jugador; si hay valores, el killer del combo debe matchear
  playerFilter: { connectCodes: [], characterIds: [] },
  lastRunAt: null,
  history: [],
};

function log(...args) {
  console.log(`[auto-shorts] ${new Date().toISOString()}`, ...args);
}

// ── Persistencia ────────────────────────────────────────────────────────────

function getConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return {
      ...DEFAULT_CONFIG,
      ...data,
      playerFilter: { ...DEFAULT_CONFIG.playerFilter, ...(data.playerFilter || {}) },
      history: Array.isArray(data.history) ? data.history : [],
    };
  } catch (e) {
    console.warn('[auto-shorts] auto-shorts.json corrupto, usando defaults:', e.message);
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config) {
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

// Valida y normaliza un patch de config (PUT /api/auto-shorts).
function validatePatch(patch) {
  const out = {};
  if (patch.enabled !== undefined) out.enabled = !!patch.enabled;
  if (patch.frequencyDays !== undefined) {
    const n = Number(patch.frequencyDays);
    if (!Number.isFinite(n) || n < 1 || n > 14) throw new Error('frequencyDays debe estar entre 1 y 14');
    out.frequencyDays = Math.round(n);
  }
  if (patch.targetDurationSec !== undefined) {
    const n = Number(patch.targetDurationSec);
    if (!Number.isFinite(n) || n < 15 || n > 90) throw new Error('targetDurationSec debe estar entre 15 y 90');
    out.targetDurationSec = Math.round(n);
  }
  if (patch.maxClips !== undefined) {
    const n = Number(patch.maxClips);
    if (!Number.isFinite(n) || n < 2 || n > 12) throw new Error('maxClips debe estar entre 2 y 12');
    out.maxClips = Math.round(n);
  }
  if (patch.minComboLength !== undefined) {
    const n = Number(patch.minComboLength);
    if (!Number.isFinite(n) || n < 1 || n > 30) throw new Error('minComboLength debe estar entre 1 y 30');
    out.minComboLength = Math.round(n);
  }
  if (patch.rules !== undefined) {
    if (patch.rules !== null && !Array.isArray(patch.rules)) throw new Error('rules debe ser null o un array');
    out.rules = patch.rules;
  }
  if (patch.playerFilter !== undefined) {
    const pf = patch.playerFilter || {};
    const connectCodes = (Array.isArray(pf.connectCodes) ? pf.connectCodes : [])
      .map((c) => String(c).trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 20);
    const characterIds = (Array.isArray(pf.characterIds) ? pf.characterIds : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 32)
      .slice(0, 26);
    out.playerFilter = { connectCodes, characterIds };
  }
  return out;
}

function updateConfig(patch) {
  const config = { ...getConfig(), ...validatePatch(patch) };
  saveConfig(config);
  return config;
}

// ── Candidatos ──────────────────────────────────────────────────────────────

// Fecha del juego desde el nombre de archivo (Game_YYYYMMDDTHHMMSS).
// Misma lógica que dashboard-server.gameDateFromName.
function gameDateFromName(p) {
  const m = path.basename(p).match(/Game_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

function clipKey(item) {
  return `${item.gamePath}:${item.stockId}`;
}

// Bonus de ELO sobre el score base del ranking.
function eloBonus(rating) {
  if (!Number.isFinite(rating)) return 0;
  if (rating >= 2200) return 40;
  if (rating >= 1800) return 25;
  if (rating >= 1400) return 10;
  return 0;
}

// Aplana los stocks del cache en items de ranking. Espejo de
// dashboard-server.topComboItems (misma fuente: sets-stocks-cache.json).
function flattenItems(gamesStocks, minHits, dateByPath) {
  const items = [];
  for (const g of gamesStocks) {
    for (const s of g.stocks || []) {
      if ((s.comboLength || 0) < minHits) continue;
      const killer = (g.players || []).find((p) => p.playerIndex === s.killerIndex);
      const victim = (g.players || []).find((p) => p.playerIndex === s.victimIndex);
      const startBase = s.comboStartFrame != null
        ? s.comboStartFrame - 4 * FPS
        : s.frame - 8 * FPS;
      items.push({
        gamePath: g.path,
        stockId: s.id,
        stage: g.stage,
        gameDate: dateByPath.get(g.path) || gameDateFromName(g.path),
        comboLength: s.comboLength,
        killMove: s.killMove ?? null,
        killMoveId: s.killMoveId ?? null,
        comboMoves: s.comboMoves ?? null,
        killPercent: s.killPercent ?? null,
        score: s.score,
        player: killer ? { connectCode: killer.connectCode, characterId: killer.characterId } : null,
        opponent: victim ? { connectCode: victim.connectCode, characterId: victim.characterId } : null,
        startFrame: Math.max(SLIPPI_FIRST_FRAME, Math.round(startBase)),
        endFrame: Math.round(s.frame + 2 * FPS),
      });
    }
  }
  return items;
}

// Carga, filtra y rankea los candidatos actuales.
// Filtros: ventana de últimos frequencyDays días, clips no usados antes,
// playerFilter, minComboLength. Scoring: score base + bonus de ELO; si hay
// reglas (config.rules o las de combo-ranking.json) ordenan ellas y el
// finalScore (con ELO) desempata; si no, ordena por finalScore desc.
async function collectCandidates(config = getConfig()) {
  let raw = {};
  if (fs.existsSync(STOCKS_CACHE_FILE)) {
    raw = JSON.parse(fs.readFileSync(STOCKS_CACHE_FILE, 'utf-8'));
  }
  const gamesStocks = Object.values(raw).filter((e) => e && e.data).map((e) => e.data);
  const gamesCache = loadCachedGames() || { games: [] };
  const dateByPath = new Map(gamesCache.games.map((g) => [g.filePath, g.date || g.startAt || null]));

  const usedKeys = new Set();
  for (const h of config.history || []) {
    for (const k of h.clips || []) usedKeys.add(k);
  }

  const cutoff = Date.now() - config.frequencyDays * 24 * 60 * 60 * 1000;
  const codes = (config.playerFilter?.connectCodes || []).map((c) => String(c).toUpperCase());
  const charIds = config.playerFilter?.characterIds || [];

  let items = flattenItems(gamesStocks, config.minComboLength, dateByPath).filter((it) => {
    if (usedKeys.has(clipKey(it))) return false;
    const t = it.gameDate ? Date.parse(it.gameDate) : NaN;
    if (!Number.isFinite(t) || t < cutoff) return false;
    if (codes.length > 0 && !codes.includes(String(it.player?.connectCode || '').toUpperCase())) return false;
    if (charIds.length > 0 && !charIds.includes(it.player?.characterId)) return false;
    return true;
  });

  // ELO de los jugadores involucrados (cache de 7 días; nunca rompe).
  const uniqueCodes = [...new Set(items.map((it) => it.player?.connectCode).filter(Boolean))];
  const ratingByCode = await ratings.getRatings(uniqueCodes);
  for (const it of items) {
    const entry = it.player?.connectCode
      ? ratingByCode[String(it.player.connectCode).toUpperCase()]
      : null;
    it.rating = entry?.rating ?? null;
    it.displayName = entry?.displayName ?? null;
    it.eloBonus = eloBonus(it.rating);
    it.baseScore = it.score || 0;
    it.finalScore = it.baseScore + it.eloBonus;
  }

  const rules = config.rules || comboRanking.loadRules().rules;
  if (rules.length > 0) {
    // Las reglas ordenan por tiers; el tiebreak interno usa item.score, que
    // aquí lleva el bonus de ELO (finalScore) — el ELO actúa de tiebreaker.
    return comboRanking.applyCustomRanking(
      items.map((it) => ({ ...it, score: it.finalScore })),
      rules
    );
  }
  items.sort((a, b) => (b.finalScore - a.finalScore) || (b.comboLength - a.comboLength));
  return items;
}

// ── Generación ──────────────────────────────────────────────────────────────

// ¿Hay ya un auto-short pendiente o renderizando en la cola?
function findActiveAutoShortJob(queue) {
  for (const status of ['running', 'pending']) {
    const job = queue
      .list({ status, limit: 100 })
      .find((j) => j.type === 'set-export' && j.payload?.autoShort);
    if (job) return job;
  }
  return null;
}

class AutoShortError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Título/descripción/tags automáticos, estilo youtube-metadata.generateMetadata.
function buildMetadata(clips, partN) {
  const title = `Highlights de la semana Pt.${partN}`.slice(0, 100);
  const players = new Map();
  for (const c of clips) {
    const code = c.player?.connectCode;
    if (code && !players.has(code)) players.set(code, c.player);
  }
  const lines = clips.map((c, i) => {
    const who = c.player ? `${c.player.connectCode} (${charName(c.player.characterId)})` : '?';
    const what = `${c.comboLength} hits${c.killMove ? ` · ${c.killMove}` : ''}${c.killPercent != null ? ` · ${c.killPercent}%` : ''}`;
    return `${i + 1}. ${who} — ${what} · ${c.stage}`;
  });
  const description = [
    `Los mejores combos recientes rankeados por reglas + ELO de Slippi.`,
    ...lines,
    '',
    'Grabado con Slippi / renderizado headless.',
  ].join('\n');
  const tags = ['melee', 'slippi', 'ssbm', 'super smash bros melee'];
  for (const p of players.values()) {
    if (p.connectCode && !/^P\d+$/i.test(p.connectCode)) {
      tags.push(String(p.connectCode).replace(/#/g, '').toLowerCase());
    }
    const c = charName(p.characterId);
    if (c && !c.startsWith('Char ')) tags.push(c.toLowerCase());
  }
  return { title, description, tags: [...new Set(tags)] };
}

// Genera y encola un auto-short. trigger: 'cron' | 'manual'.
// `candidates` opcional: lista pre-calculada por tick() para no recalcular.
// Devuelve { jobId, entry, clipCount, estimatedMinutes }.
async function generateAutoShort(queue, trigger = 'manual', candidates = null) {
  const config = getConfig();
  const active = findActiveAutoShortJob(queue);
  if (active) {
    throw new AutoShortError(`Ya hay un auto-short en cola o renderizando (${active.id})`, 409);
  }

  if (!candidates) candidates = await collectCandidates(config);
  if (candidates.length < MIN_CANDIDATES) {
    throw new AutoShortError(`Solo hay ${candidates.length} candidatos (mínimo ${MIN_CANDIDATES})`, 422);
  }

  // Top clips hasta llenar targetDurationSec (máx. maxClips).
  const clips = [];
  let totalSec = 0;
  for (const c of candidates) {
    if (clips.length >= config.maxClips) break;
    if (clips.length > 0 && totalSec >= config.targetDurationSec) break;
    clips.push(c);
    totalSec += Math.max(4, (c.endFrame - c.startFrame) / FPS);
  }

  const partN = (config.history || []).length + 1;
  const metadata = buildMetadata(clips, partN);
  const name = `auto-shorts-pt${partN}`;

  const jobId = queue.add('set-export', {
    setId: null,
    name,
    type: 'reel',
    items: clips.map((c) => ({
      gamePath: c.gamePath,
      stockId: String(c.stockId),
      startFrame: c.startFrame,
      endFrame: c.endFrame,
    })),
    targetDurationSec: config.targetDurationSec,
    vertical: true,
    leadSeconds: 0,
    music: null,
    autoShort: true,
    youtubeMeta: metadata,
  });

  const entry = {
    id: `as-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    jobId,
    title: metadata.title,
    name,
    trigger,
    clips: clips.map(clipKey),
    players: [...new Set(clips.map((c) => c.player?.connectCode).filter(Boolean))],
    createdAt: new Date().toISOString(),
  };
  const updated = getConfig();
  updated.lastRunAt = entry.createdAt;
  updated.history = [...(updated.history || []), entry].slice(-50);
  saveConfig(updated);

  const estimatedMinutes = Math.max(1, Math.ceil((totalSec * 1.5) / 60));
  log(`Auto-short encolado (${trigger}): ${metadata.title} — ${clips.length} clips, job ${jobId}`);
  return { jobId, entry, clipCount: clips.length, estimatedMinutes, title: metadata.title };
}

// Estado de cada entry del history resuelto contra la cola y los approvals
// (renderizando → pendiente de aprobación → subido/descartado).
function resolveHistory(queue) {
  const config = getConfig();
  return (config.history || []).map((entry) => {
    const job = entry.jobId ? queue.get(entry.jobId) : null;
    const outputPath = job?.progress?.outputPath || null;
    const approval = outputPath ? approvals.findByFilePath(outputPath) : null;
    let status = 'queued';
    if (approval) {
      status = approval.status === 'uploaded' ? 'uploaded'
        : approval.status === 'discarded' ? 'discarded'
        : 'approval-pending';
    } else if (job) {
      status = job.status === 'completed' ? 'rendered'
        : job.status === 'failed' ? 'error'
        : job.status === 'cancelled' ? 'cancelled'
        : job.status; // pending | running
    }
    return {
      ...entry,
      status,
      outputUrl: job?.progress?.outputUrl || null,
      youtubeUrl: approval?.youtubeUrl || null,
      approvalId: approval?.id || null,
      error: job?.error || null,
    };
  });
}

// ── Tick (cada 60s desde worker-server.js) ──────────────────────────────────

let ticking = false;
async function tick(queue) {
  if (ticking) return;
  ticking = true;
  try {
    const config = getConfig();
    if (!config.enabled) return;
    if (config.lastRunAt) {
      const elapsed = Date.now() - Date.parse(config.lastRunAt);
      if (Number.isFinite(elapsed) && elapsed < config.frequencyDays * 24 * 60 * 60 * 1000) return;
    }
    if (findActiveAutoShortJob(queue)) return; // ya hay uno en cola/renderizando
    const candidates = await collectCandidates(config);
    if (candidates.length < MIN_CANDIDATES) {
      log(`Pocos candidatos (${candidates.length} < ${MIN_CANDIDATES}); se reintenta en el próximo tick.`);
      return;
    }
    await generateAutoShort(queue, 'cron', candidates);
  } catch (err) {
    log('Error en tick:', err.message);
  } finally {
    ticking = false;
  }
}

module.exports = {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  MIN_CANDIDATES,
  getConfig,
  saveConfig,
  updateConfig,
  validatePatch,
  collectCandidates,
  generateAutoShort,
  findActiveAutoShortJob,
  resolveHistory,
  tick,
  AutoShortError,
};
