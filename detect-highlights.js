// detect-highlights.js
// Lee un archivo .slp y devuelve una lista de "ventanas" de highlight
// (rangos de frames) basados en combos largos que terminen en stock perdido.
//
// Todo es codigo puro sobre los datos de slippi-js: no usa AI ni vision.

const { SlippiGame } = require('@slippi/slippi-js');

const FPS = 60; // Melee corre ~59.94fps, usamos 60 para simplificar

// Defaults
const DEFAULT_PADDING_SECONDS_BEFORE = 3.0;
const DEFAULT_PADDING_SECONDS_AFTER  = 2.0;
const DEFAULT_MIN_MOVES = 4;
const DEFAULT_MAX_MOVES = Infinity;

/**
 * Normaliza un nombre/tag de Slippi para comparar sin importar mayusculas.
 * @param {string} s
 */
function normalizeName(s) {
  if (!s || typeof s !== 'string') return '';
  return s.trim().toUpperCase();
}

/**
 * Devuelve true si el jugador coincide con alguno de los targets.
 * Prioriza connectCode y nametag (identificadores de Slippi) para evitar
 * falsos positivos en displayName (ej. "bontalor" contiene "alor").
 * @param {any} player
 * @param {string[]} targets nombres/tags a buscar (ya normalizados o no)
 */
function playerMatches(player, targets) {
  if (!player || !targets || targets.length === 0) return false;
  const normalizedTargets = targets.map(normalizeName).filter(Boolean);
  if (normalizedTargets.length === 0) return false;

  const connectCode = normalizeName(player.connectCode);
  const nametag = normalizeName(player.nametag);

  // 1. Coincidencia en connectCode o nametag (incluye parcial, ej ALOR en ALOR#511)
  const identifiers = [connectCode, nametag].filter(Boolean);
  if (identifiers.length > 0) {
    const idMatch = normalizedTargets.some((target) =>
      identifiers.some((id) => id.includes(target))
    );
    if (idMatch) return true;
  }

  // 2. Solo si no hay identificador, usamos displayName por palabras completas
  const displayName = normalizeName(player.displayName);
  if (!displayName) return false;
  const words = displayName.split(/[\s#\-_]+/).filter(Boolean);
  return normalizedTargets.some((target) =>
    words.some((w) => w === target || w.startsWith(target))
  );
}

/**
 * Encuentra el frame en el que la victima pierde su stock.
 * @param {SlippiGame} game
 * @param {number} victimIndex
 * @param {number} fromFrame
 * @param {number} toFrame
 * @returns {number | null} frame de muerte o null si no se detecto
 */
function findStockLossFrame(frames, victimIndex, fromFrame, toFrame) {
  try {
    let previousStocks = null;

    for (let f = fromFrame; f <= toFrame; f++) {
      const frame = frames[f];
      if (!frame || !frame.players || !frame.players[victimIndex]) continue;
      const post = frame.players[victimIndex].post;
      const stocks = post?.stocksRemaining ?? post?.stocks;
      if (post == null || typeof stocks !== 'number') continue;

      if (previousStocks !== null && stocks < previousStocks) {
        return f; // stock perdido en este frame
      }
      previousStocks = stocks;
    }
  } catch (e) {
    console.warn('[detect-highlights] Error buscando stock loss:', e.message);
  }
  return null;
}

/**
 * Detecta highlights en un .slp segun criterios configurables.
 *
 * @param {string} slpPath ruta al archivo .slp
 * @param {object} opts
 * @param {string[]} [opts.attackers] nombres/tags del atacante, ej ['HARD','JIMY']
 * @param {string[]} [opts.victims] nombres/tags de la victima, ej ['DOLF','ALOR']
 * @param {number} [opts.minMoves=4] minimo de golpes en el combo
 * @param {number} [opts.maxMoves=Infinity] maximo de golpes (Infinity = sin limite)
 * @param {number} [opts.padBeforeSeconds=3.0] margen antes del primer golpe
 * @param {number} [opts.padAfterSeconds=2.0] margen despues de la muerte
 * @param {boolean} [opts.requireKill=true] el combo debe terminar en stock perdido
 * @param {boolean} [opts.allowInterrupted=true] si true, acepta combos que en slippi
 *   se dividieron en varios combos pero que en total llevaron al stock loss dentro de
 *   un rango corto (3s). Util para clips largos con un golpe de interrupcion.
 * @param {boolean} [opts.fastMode=false] si true, no carga frames (mucho mas rapido)
 *   y usa combo.endFrame + padAfter como fin aproximado. Util para escanear miles de
 *   replays; para clips finales puede activarse el modo lento para precision exacta.
 * @returns {Array<{startFrame:number, endFrame:number, playerIndex:number, reason:string}>}
 */
function detectHighlights(slpPath, opts = {}) {
  const {
    attackers = ['HARD', 'JIMY'],
    victims = null, // null = cualquiera
    minMoves = DEFAULT_MIN_MOVES,
    maxMoves = DEFAULT_MAX_MOVES,
    padBeforeSeconds = DEFAULT_PADDING_SECONDS_BEFORE,
    padAfterSeconds = DEFAULT_PADDING_SECONDS_AFTER,
    requireKill = true,
    allowInterrupted = true,
    fastMode = false,
  } = opts;

  let game;
  try {
    game = new SlippiGame(slpPath);
  } catch (e) {
    console.warn(`[detect-highlights] No se pudo abrir ${slpPath}: ${e.message}`);
    return [];
  }

  let settings;
  try {
    settings = game.getSettings();
  } catch (e) {
    console.warn(`[detect-highlights] No se pudieron leer settings de ${slpPath}: ${e.message}`);
    return [];
  }

  if (!settings || !settings.players) {
    console.warn(`[detect-highlights] Sin players en ${slpPath}`);
    return [];
  }

  let stats;
  try {
    stats = game.getStats();
  } catch (e) {
    console.warn(`[detect-highlights] No se pudieron leer stats de ${slpPath}: ${e.message}`);
    return [];
  }

  if (!stats || !stats.combos) {
    return [];
  }

  const startFrame = settings.startFrame ?? -123;
  const lastFrame = settings.lastFrame ?? stats.lastFrame ?? Infinity;
  const padBefore = Math.round(padBeforeSeconds * FPS);
  const padAfter = Math.round(padAfterSeconds * FPS);

  // Combos candidatos: atacante y victima coinciden, golpes en rango, y opcionalmente kill.
  const candidateCombos = stats.combos.filter((combo) => {
    if (combo.moves.length < minMoves) return false;
    if (combo.moves.length > maxMoves) return false;

    const aggressorIndex = combo.moves[0]?.playerIndex ?? combo.lastHitBy;
    const aggressor = settings.players.find((p) => p.playerIndex === aggressorIndex);
    const victim = settings.players.find((p) => p.playerIndex === combo.playerIndex);

    if (!aggressor || !victim) return false;
    if (!playerMatches(aggressor, attackers)) return false;
    if (victims && victims.length > 0 && !playerMatches(victim, victims)) return false;

    // No filtramos por combo.didKill porque slippi-js lo marca false cuando hay
    // interrupciones. Buscamos stock loss manualmente en un rango amplio.

    return true;
  });

  if (candidateCombos.length === 0) return [];

  // Cargar frames una sola vez para buscar stock loss de todos los candidatos.
  // En fastMode evitamos getFrames() (operacion muy lenta) y usamos combo.endFrame
  // como aproximacion del stock loss, con un padAfter mayor para asegurar ver la muerte.
  let frames = null;
  const fastModePadAfter = fastMode ? Math.round(padAfterSeconds * FPS * 2) : padAfter;
  if (!fastMode) {
    try {
      frames = game.getFrames();
    } catch (e) {
      console.warn(`[detect-highlights] No se pudieron cargar frames de ${slpPath}: ${e.message}`);
      return [];
    }
  }

  let rawWindows = candidateCombos
    .map((combo) => {
      const aggressorIndex = combo.moves[0]?.playerIndex ?? combo.lastHitBy;
      const victimIndex = combo.playerIndex;
      const aggressor = settings.players.find((p) => p.playerIndex === aggressorIndex);
      const victim = settings.players.find((p) => p.playerIndex === victimIndex);

      let stockLossFrame = null;
      let endFrame;
      if (fastMode) {
        stockLossFrame = combo.endFrame;
        endFrame = combo.endFrame + fastModePadAfter;
      } else {
        const searchEnd = Math.min(lastFrame, combo.endFrame + FPS * 15);
        stockLossFrame = findStockLossFrame(frames, victimIndex, combo.startFrame, searchEnd);
        if (requireKill && stockLossFrame === null) return null;
        endFrame = (stockLossFrame !== null ? stockLossFrame : combo.endFrame) + padAfter;
      }

      const attackerName =
        aggressor?.nametag || aggressor?.connectCode || `P${aggressorIndex + 1}`;
      const victimName =
        victim?.nametag || victim?.connectCode || `P${victimIndex + 1}`;

      return {
        startFrame: Math.max(startFrame, combo.startFrame - padBefore),
        endFrame,
        playerIndex: aggressorIndex,
        aggressor,
        victim,
        combo,
        stockLossFrame,
        reason: `${attackerName} mata a ${victimName} (${combo.moves.length} golpes)`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startFrame - b.startFrame);

  // Si allowInterrupted, intenta unir combos del mismo atacante contra la misma victima
  // que esten a menos de 3 segundos y que en conjunto lleguen a un stock loss.
  if (allowInterrupted) {
    const merged = [];
    const MAX_GAP = FPS * 2; // maximo 2 segundos entre combos para unirlos

    for (const win of rawWindows) {
      const last = merged[merged.length - 1];
      const gap = win.startFrame - last?.endFrame;
      if (
        last &&
        win.playerIndex === last.playerIndex &&
        win.victim?.playerIndex === last.victim?.playerIndex &&
        gap <= MAX_GAP &&
        gap >= 0
      ) {
        last.endFrame = Math.max(last.endFrame, win.endFrame);
        last.reason = `${last.reason.split(' (')[0]} + ${win.reason}`;
        last.combo.moves = last.combo.moves.concat(win.combo.moves);
      } else {
        merged.push({ ...win });
      }
    }
    rawWindows = merged;
  }

  // Fusiona ventanas que se solapan o estan muy cerca (menos de 1s de separacion)
  const merged = [];
  const MERGE_GAP_FRAMES = FPS * 1;

  for (const win of rawWindows) {
    const last = merged[merged.length - 1];
    if (last && win.startFrame - last.endFrame <= MERGE_GAP_FRAMES) {
      last.endFrame = Math.max(last.endFrame, win.endFrame);
      last.reason += ` + ${win.reason}`;
    } else {
      merged.push({ ...win });
    }
  }

  return merged;
}

module.exports = { detectHighlights, playerMatches, normalizeName };

// Uso standalone: node detect-highlights.js archivo.slp [attacker1,attacker2] [victim1,victim2]
if (require.main === module) {
  const slpPath = process.argv[2];
  if (!slpPath) {
    console.error('Uso: node detect-highlights.js <archivo.slp> [atacantes] [victimas]');
    process.exit(1);
  }
  const attackers = process.argv[3] ? process.argv[3].split(',').map((s) => s.trim().toUpperCase()) : ['HARD'];
  const victims = process.argv[4] ? process.argv[4].split(',').map((s) => s.trim().toUpperCase()) : null;
  const highlights = detectHighlights(slpPath, { attackers, victims });
  console.log(JSON.stringify(highlights, null, 2));
}
