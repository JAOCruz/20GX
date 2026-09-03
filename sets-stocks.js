// sets-stocks.js
// Detalle de stocks por juego de un set, con scoring para highlight reels.
// Usa el mismo enfoque que detect-stocks.js (drops de stocksRemaining en
// post-frame + game.getStats().combos para kill move / kill percent).
// Cachea resultados en sets-stocks-cache.json por ruta + mtime del archivo.

const fs = require('fs');
const path = require('path');
const { SlippiGame, Stage } = require('@slippi/slippi-js');
const { findAllStockEvents, findQuitEvent } = require('./detect-stocks');
const { formatStageName, scanReplay } = require('./scan-replays');

const CACHE_FILE = path.join(__dirname, 'sets-stocks-cache.json');

// Padding por defecto de los clips de stock (igual que render-selected-stocks).
const LEAD_SECONDS = Number(process.env.PADDING_BEFORE || '7');
const PAD_AFTER_SECONDS = Number(process.env.PADDING_AFTER || '2');
// Segundos de neutral antes de que empiece el combo/punish (contexto).
const CONTEXT_BEFORE_SECONDS = Number(process.env.CONTEXT_BEFORE || '4');

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    console.warn('[sets-stocks] Cache corrupto, ignorando:', e.message);
    return {};
  }
}

function saveCache(cache) {
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, CACHE_FILE);
}

/**
 * Score de un kill para reels.
 *   score = comboLength * 2 + max(0, (150 - killPercent)) / 20 + 1
 * - comboLength: cantidad de moves del combo que mató, sin pummels
 *   (más largo = más hype).
 * - killPercent: kills a bajo % (tempranos) suman más; a 150%+ no suma nada.
 * Defaults razonables cuando falta data: comboLength 1, killPercent 100.
 */
function scoreKill(kill) {
  const comboLength = kill.comboLength || 1;
  const killPercent = typeof kill.killPercent === 'number' ? kill.killPercent : 100;
  const score = comboLength * 2 + Math.max(0, (150 - killPercent)) / 20 + 1;
  return Math.round(score * 100) / 100;
}

// Calcula los stocks de un juego (sin cache). Devuelve la estructura del endpoint.
function computeGameStocks(slpPath) {
  const game = new SlippiGame(slpPath);
  const settings = game.getSettings();
  if (!settings || !settings.players || settings.players.length < 2) {
    throw new Error(`Replay inválido o sin 2 jugadores: ${path.basename(slpPath)}`);
  }

  const players = settings.players.slice(0, 2).map((p) => ({
    connectCode: p.connectCode || p.displayName || `P${p.playerIndex + 1}`,
    characterId: p.characterId,
    playerIndex: p.playerIndex,
  }));

  // conversions > combos: cubren el punish COMPLETO desde el primer hit
  // (los combos de slippi-js se cortan cuando la víctima es actionable y se
  // pierden kills en replays viejos). Mismo shape: playerIndex=víctima.
  const combos = game.getStats()?.conversions || game.getStats()?.combos || [];
  const stocks = [];
  // TODAS las caídas de stock de ambos jugadores en una pasada (incluye SDs
  // con killerIndex null) + evento sintético de quit (LRAS) si el juego
  // terminó porque alguien se salió: ese momento también es clip-able.
  const events = findAllStockEvents(game, combos, players[0].playerIndex, players[1].playerIndex);
  const quitEvent = findQuitEvent(game, combos, players[0].playerIndex, players[1].playerIndex);
  if (quitEvent) events.push(quitEvent);
  for (const kill of events) {
    stocks.push({
      id: `k${kill.frame}`,
      frame: kill.frame,
      timeSeconds: kill.timeSeconds,
      killerIndex: kill.killerIndex,
      victimIndex: kill.victimIndex,
      killPercent: kill.killPercent ?? null,
      killMove: kill.killMove || null,
      killMoveId: kill.killMoveId ?? null,
      comboMoves: kill.comboMoves || null,
      comboLength: kill.comboLength || 0,
      comboStartFrame: kill.comboStartFrame ?? null,
      sd: !!kill.sd,
      quit: !!kill.quit,
    });
  }
  stocks.sort((a, b) => a.frame - b.frame);
  for (const s of stocks) s.score = scoreKill(s);

  // Duración total del juego (para estimar peso/duración de exports de set completo).
  const lastFrame = game.getMetadata()?.lastFrame;
  const durationSec = typeof lastFrame === 'number' ? Math.round(Math.max(0, lastFrame + 123) / 60) : null;

  // Ganador oficial (placements, con la regla de timeout de scan-replays).
  // Fuente única de verdad para la corona del UI y el score del set: el
  // heuristico "killer del último stock" se equivoca cuando dos stocks caen
  // en el mismo segundo (típico del último stock: el perdedor mata al
  // ganador y muere casi al instante).
  let winnerIndex = null;
  try {
    winnerIndex = scanReplay(slpPath)?.winnerPlayerIndex ?? null;
  } catch {
    winnerIndex = null;
  }

  return {
    path: slpPath,
    stage: formatStageName(Stage[settings.stageId]) || `Stage ${settings.stageId}`,
    durationSec,
    winnerIndex,
    players,
    stocks,
  };
}

// Versión cacheada: clave = ruta, válida mientras el mtime no cambie.
// v5: conversions en vez de combos (punish completo + kills que combos pierde).
// v6: comboLength sin pummels (moveId 52); el grab y los throws sí cuentan.
// v7: winnerIndex por juego (placements con regla de timeout).
// v8: killMoveId + comboMoves por stock (ranking personalizado por golpes).
// v9: SDs (killerIndex null, sd:true) y evento de quit LRAS (quit:true) ya no
//     desaparecen de la lista de stocks.
const CACHE_VERSION = 9;
function getGameStocks(slpPath) {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(slpPath).mtimeMs;
  } catch (e) {
    throw new Error(`No existe el replay: ${slpPath}`);
  }

  const cache = loadCache();
  const entry = cache[slpPath];
  if (entry && entry.v === CACHE_VERSION && entry.mtimeMs === mtimeMs && entry.data) {
    return entry.data;
  }

  const data = computeGameStocks(slpPath);
  cache[slpPath] = { v: CACHE_VERSION, mtimeMs, data };
  try {
    saveCache(cache);
  } catch (e) {
    console.warn('[sets-stocks] No se pudo guardar cache:', e.message);
  }
  return data;
}

function getSetStocks(set) {
  const games = [];
  const errors = [];
  const overrides = set.winnerOverrides || {};
  for (const gamePath of set.gamePaths || []) {
    try {
      const data = getGameStocks(gamePath);
      // Override manual del ganador (corrección desde el dashboard). Se aplica
      // post-cache para no ensuciar el cache en disco.
      const ov = overrides[gamePath];
      games.push(ov != null ? { ...data, winnerIndex: ov } : data);
    } catch (e) {
      errors.push({ path: gamePath, error: e.message });
    }
  }
  return { games, errors };
}

// Estimación de duración de un clip de stock: lead + pad + ~5s del momento
// del kill (aprox del span kill-to-death, que no medimos frame a frame).
function estimateStockClipSeconds() {
  return LEAD_SECONDS + PAD_AFTER_SECONDS + 5;
}

/**
 * Auto-selección de stocks para un reel: los de mayor score del set hasta
 * llenar targetDurationSec. Devuelve items [{ gamePath, stockId }] en orden
 * de score descendente.
 */
function selectStocksForDuration(setStocks, targetDurationSec) {
  const all = [];
  for (const g of setStocks.games) {
    for (const s of g.stocks) {
      all.push({ gamePath: g.path, stockId: s.id, score: s.score });
    }
  }
  all.sort((a, b) => b.score - a.score);

  const perClip = estimateStockClipSeconds();
  const items = [];
  let acc = 0;
  for (const item of all) {
    if (targetDurationSec && acc >= targetDurationSec) break;
    items.push({ gamePath: item.gamePath, stockId: item.stockId });
    acc += perClip;
  }
  return items;
}

module.exports = {
  CACHE_FILE,
  scoreKill,
  computeGameStocks,
  getGameStocks,
  getSetStocks,
  estimateStockClipSeconds,
  selectStocksForDuration,
  LEAD_SECONDS,
  PAD_AFTER_SECONDS,
  CONTEXT_BEFORE_SECONDS,
};
