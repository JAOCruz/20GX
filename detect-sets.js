// detect-sets.js
// Detección automática de sets a partir de los juegos cacheados del scan.
//
// Reglas:
//   - Agrupa juegos con el mismo par de connectCodes y el mismo día calendario.
//   - Dentro del grupo, ordenados por hora, corta el grupo si hay un gap > 15 min
//     entre el fin de un juego y el inicio del siguiente.
//   - Acumula wins por jugador (winnerPlayerIndex del scan).
//   - Si alguien llega a 10 wins y quedan juegos después, cierra el set ahí
//     (FT10 terminado) y empieza uno nuevo con los juegos restantes.
//   - El formato es FT{N} donde N = wins del ganador al final del set (si N >= 3).
//   - No duplica: se salta grupos cuyos gamePaths exactos ya existen en un set.

const { createSet, autoName } = require('./sets-store');

const MAX_GAP_MS = 15 * 60 * 1000;
const CLOSE_OUT_WINS = 10; // al llegar a 10 wins el set se considera cerrado
const MIN_SET_GAMES = 3; // grupos de 1-2 juegos no cuentan como set

function gameEndMs(game) {
  return game.startTimestamp + (game.duration || 0) * 1000;
}

function pairKeyOf(game) {
  const codes = (game.players || [])
    .map((p) => p.connectCode)
    .filter((c) => c && c !== '—')
    .sort();
  return codes.length === 2 ? codes.join('|') : null;
}

function winnerConnectCode(game) {
  if (game.winnerPlayerIndex == null) return null;
  const p = (game.players || []).find((pl) => pl.playerIndex === game.winnerPlayerIndex);
  return p ? p.connectCode : null;
}

// Construye el objeto set a partir de un grupo ordenado de juegos.
function buildSetFromGroup(groupGames) {
  const first = groupGames[0];
  const codes = pairKeyOf(first).split('|');

  // connectCode -> characterId del primer juego donde aparece
  const charByCode = {};
  for (const g of groupGames) {
    for (const p of g.players || []) {
      if (p.connectCode && charByCode[p.connectCode] === undefined) {
        charByCode[p.connectCode] = p.characterId;
      }
    }
  }

  const winsByCode = { [codes[0]]: 0, [codes[1]]: 0 };
  for (const g of groupGames) {
    const w = winnerConnectCode(g);
    if (w && winsByCode[w] !== undefined) winsByCode[w]++;
  }

  const wins = [winsByCode[codes[0]], winsByCode[codes[1]]];
  const maxWins = Math.max(...wins);
  const format = maxWins >= 3 ? `FT${maxWins}` : null;
  const players = codes.map((connectCode) => ({ connectCode, characterId: charByCode[connectCode] ?? null }));
  const date = first.startAt || null;

  return {
    name: autoName(players, date),
    source: 'auto',
    players,
    gamePaths: groupGames.map((g) => g.filePath),
    wins,
    format,
    date,
  };
}

// Divide los juegos de un par+día en grupos por gaps de tiempo y luego
// en sub-sets cuando alguien cierra un FT10 y siguen jugando.
function splitIntoSets(games) {
  const groups = [];
  let current = [games[0]];
  for (let i = 1; i < games.length; i++) {
    const gap = games[i].startTimestamp - gameEndMs(games[i - 1]);
    if (gap > MAX_GAP_MS) {
      groups.push(current);
      current = [];
    }
    current.push(games[i]);
  }
  groups.push(current);

  const sets = [];
  for (const group of groups) {
    let sub = [];
    const wins = {};
    for (const g of group) {
      sub.push(g);
      const w = winnerConnectCode(g);
      if (w) wins[w] = (wins[w] || 0) + 1;
      // Cierre anticipado: alguien llegó a 10 y aún quedan juegos del grupo.
      if ((wins[w] || 0) >= CLOSE_OUT_WINS && sub.length < group.length) {
        if (sub.length >= MIN_SET_GAMES) sets.push(sub);
        sub = [];
        for (const k of Object.keys(wins)) wins[k] = 0;
      }
    }
    if (sub.length >= MIN_SET_GAMES) sets.push(sub);
  }
  return sets;
}

/**
 * Detecta sets nuevos sobre la lista de juegos (formato del cache del scan).
 * @param {Array} games juegos con filePath, startTimestamp, duration, players, winnerPlayerIndex
 * @param {Array} existingSets sets ya guardados (para no duplicar)
 * @returns {{ added: number, sets: Array }} los sets recién creados
 */
function detectSets(games, existingSets = []) {
  const eligible = (games || []).filter((g) => g.filePath && g.startTimestamp && pairKeyOf(g));

  const byPairDay = new Map();
  for (const g of eligible) {
    const day = new Date(g.startTimestamp).toISOString().slice(0, 10);
    const key = `${pairKeyOf(g)}|${day}`;
    if (!byPairDay.has(key)) byPairDay.set(key, []);
    byPairDay.get(key).push(g);
  }

  // Huellas de sets existentes: lista exacta de gamePaths.
  const fingerprints = new Set(
    existingSets.map((s) => JSON.stringify(s.gamePaths || []))
  );

  const created = [];
  for (const groupGames of byPairDay.values()) {
    groupGames.sort((a, b) => a.startTimestamp - b.startTimestamp);
    for (const setGames of splitIntoSets(groupGames)) {
      const data = buildSetFromGroup(setGames);
      if (fingerprints.has(JSON.stringify(data.gamePaths))) continue;
      fingerprints.add(JSON.stringify(data.gamePaths));
      created.push(createSet(data));
    }
  }

  return { added: created.length, sets: created };
}

module.exports = { detectSets, buildSetFromGroup, MAX_GAP_MS, MIN_SET_GAMES };
